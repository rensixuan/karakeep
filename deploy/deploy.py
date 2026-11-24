#!/usr/bin/env python3
"""Deploy this checkout with Docker Compose. Only Python's standard library is used."""
import argparse
import base64
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import shlex
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

DIRECTORY = Path(__file__).resolve().parent


def read_env(file):
    result = {}
    for line in file.read_text().splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        key, value = line.split("=", 1)
        values = shlex.split(value, comments=True)
        result[key.strip()] = values[0] if values else ""
    return result


def private_write(file, text):
    descriptor = os.open(file, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write(text)


def url_settings(raw):
    if any(ord(char) < 32 for char in raw):
        raise ValueError("URL must not contain control characters")
    url = urllib.parse.urlsplit(raw)
    if (url.scheme not in {"http", "https"} or not url.hostname or
            url.username or url.password or url.path not in {"", "/"} or url.query or url.fragment):
        raise ValueError("Use an http(s) origin without credentials, path or query")
    host = url.hostname.encode("idna").decode()
    if not re.fullmatch(r"[a-zA-Z0-9.-]+", host):
        raise ValueError("Use a DNS hostname or IPv4 address")
    if url.scheme == "https" and (url.port not in {None, 443} or "." not in host):
        raise ValueError("HTTPS requires a domain and the standard port 443")
    port = url.port or (443 if url.scheme == "https" else 80)
    return {
        "NEXTAUTH_URL": f"{url.scheme}://{host}" + (f":{url.port}" if url.port else ""),
        "WEB_BIND": "127.0.0.1" if url.scheme == "https" or host in {"localhost", "127.0.0.1"} else "0.0.0.0",
        "WEB_PORT": "3000" if url.scheme == "https" else str(port),
        "COMPOSE_PROFILES": "https" if url.scheme == "https" else "",
        "CADDY_SITE": host,
    }


def prepare(directory, args):
    env_file = directory / ".env"
    credential_file = directory / "admin-credentials.json"
    if env_file.exists():
        env = read_env(env_file)
        if args.url and url_settings(args.url)["NEXTAUTH_URL"] != env.get("NEXTAUTH_URL"):
            raise ValueError("Existing URL differs; edit .env deliberately instead of reinitializing")
        if args.project_name and args.project_name != env.get("COMPOSE_PROJECT_NAME"):
            raise ValueError("Existing project name differs; keep the name to retain its data volumes")
        if args.image and args.image != env.get("KARAKEEP_IMAGE"):
            raise ValueError("Existing image differs; update KARAKEEP_IMAGE in .env before upgrading")
        if not credential_file.exists():
            raise ValueError("Restore admin-credentials.json; existing installations are not reinitialized")
        credentials = json.loads(credential_file.read_text())
        if args.email and args.email.lower() != credentials.get("email"):
            raise ValueError("Existing administrator differs; passwords are never reset by this script")
    else:
        env = read_env(directory / ".env.example")
        env.update(url_settings(args.url or "http://localhost:3000"))
        env["COMPOSE_PROJECT_NAME"] = args.project_name or "karakeep"
        if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", env["COMPOSE_PROJECT_NAME"]):
            raise ValueError("Invalid Compose project name")
        env["KARAKEEP_IMAGE"] = args.image or "karakeep-custom:local"
        env["NEXTAUTH_SECRET"] = secrets.token_hex(32)
        env["MEILI_MASTER_KEY"] = secrets.token_hex(32)
        env["TRANSLATION_ENCRYPTION_KEY"] = base64.b64encode(secrets.token_bytes(32)).decode()
        email = (args.email or "admin@example.com").lower()
        if not re.fullmatch(r"[^\s@]+@[^\s@]+\.[^\s@]+", email):
            raise ValueError("Invalid administrator email")
        credentials = {"email": email, "password": secrets.token_urlsafe(24)}
        if credential_file.exists():
            # An interruption before .env was written must not discard the generated password.
            credentials = json.loads(credential_file.read_text())
            if args.email and credentials["email"] != email:
                raise ValueError("Existing credential file belongs to a different administrator")
        else:
            private_write(credential_file, json.dumps(credentials, indent=2) + "\n")
        private_write(env_file, "".join(f"{key}={json.dumps(value, ensure_ascii=False)}\n" for key, value in env.items()))
    for key in ["NEXTAUTH_SECRET", "MEILI_MASTER_KEY", "TRANSLATION_ENCRYPTION_KEY"]:
        if len(env.get(key, "")) < 32 or "GENERATED_BY" in env[key]:
            raise ValueError(f"Set a real value for {key}; .env.example is only a template")
    if len(base64.b64decode(env["TRANSLATION_ENCRYPTION_KEY"], validate=True)) != 32:
        raise ValueError("TRANSLATION_ENCRYPTION_KEY must decode to 32 bytes")
    if env.get("DISABLE_SIGNUPS") != "true":
        raise ValueError("This deployment keeps public registration disabled")
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", env["COMPOSE_PROJECT_NAME"]):
        raise ValueError("Invalid Compose project name")
    if not 1 <= int(env["WEB_PORT"]) <= 65535:
        raise ValueError("Invalid web port")
    for file in [env_file, credential_file]:
        file.chmod(0o600)
    return env, credentials


def run(command, *, capture=False, check=True, env=None):
    result = subprocess.run(command, cwd=DIRECTORY, text=True, capture_output=capture, env=env)
    if check and result.returncode:
        # Captured output can contain private configuration; never include it in exceptions.
        raise RuntimeError(f"Command failed: {' '.join(command[:3])} (exit {result.returncode})")
    return result


def check_project(project, configured):
    result = run(["docker", "ps", "-aq", "--filter", f"label=com.docker.compose.project={project}"], capture=True)
    ids = result.stdout.split()
    if ids:
        containers = json.loads(run(["docker", "inspect", *ids], capture=True).stdout)
        for container in containers:
            working = container["Config"]["Labels"].get("com.docker.compose.project.working_dir", "")
            if not configured or Path(working).resolve() != DIRECTORY:
                raise ValueError("This project name is already used elsewhere; choose --project-name")
    volume = run(["docker", "volume", "inspect", f"{project}_data"], capture=True, check=False)
    if not configured and volume.returncode == 0:
        raise ValueError("Existing data found without .env; restore its secrets instead of generating new ones")


def wait_for_health(origin, timeout=300):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(origin + "/api/health", timeout=10) as response:
                if response.status == 200:
                    return
        except (urllib.error.URLError, OSError):
            pass
        time.sleep(3)
    raise RuntimeError("Application did not become healthy; inspect docker compose logs")


def check_application(env, credentials, require_login):
    origin = f"http://127.0.0.1:{env['WEB_PORT']}"
    wait_for_health(origin)
    cookies = http.cookiejar.CookieJar()
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    def request(route, data=None):
        req = urllib.request.Request(origin + route,
            data=json.dumps(data).encode() if data is not None else None,
            headers={"Content-Type": "application/json", "Origin": env["NEXTAUTH_URL"]})
        with opener.open(req, timeout=30) as response:
            return json.loads(response.read() or b"null")

    try:
        request("/api/auth/sign-in/email", {**credentials, "rememberMe": False})
    except urllib.error.HTTPError as error:
        if error.code == 401 and not require_login:
            print("Health check passed. Existing account password has changed; no password was reset.")
            return
        raise RuntimeError(f"Administrator login check failed (HTTP {error.code})") from None
    try:
        user = request("/api/v1/users/me")
        if user["email"] != credentials["email"]:
            raise RuntimeError("Login returned an unexpected account")
        query = urllib.parse.quote(json.dumps({"json": None}))
        settings = request("/api/trpc/translations.settings?input=" + query)["result"]["data"]["json"]
        if not settings["encryptionAvailable"]:
            raise RuntimeError("Reader translation encryption is unavailable")
        print("Health, administrator login and Reader translation configuration checks passed.")
    finally:
        request("/api/auth/sign-out", {})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Public URL; defaults to http://localhost:3000")
    parser.add_argument("--email", help="Initial administrator email; defaults to admin@example.com")
    parser.add_argument("--image", help="Use a prebuilt image instead of building this checkout")
    parser.add_argument("--project-name", help="Isolate another installation's volumes and containers")
    parser.add_argument("--build", action="store_true", help="Rebuild the local image from this checkout")
    parser.add_argument("--pull", action="store_true", help="Pull the configured prebuilt image again")
    parser.add_argument("--prepare-only", action="store_true", help="Generate configuration without starting services")
    args = parser.parse_args()
    if args.build and args.pull:
        parser.error("Choose --build or --pull")
    if not args.prepare_only:
        run(["docker", "compose", "version"], capture=True)
        run(["docker", "info"], capture=True)
        saved = read_env(DIRECTORY / ".env") if (DIRECTORY / ".env").exists() else {}
        check_project(args.project_name or saved.get("COMPOSE_PROJECT_NAME", "karakeep"), bool(saved))
    env, credentials = prepare(DIRECTORY, args)
    if args.prepare_only:
        print("Prepared .env and admin-credentials.json with private permissions.")
        return
    # Compose must read our persisted values, not an unrelated shell's exported settings.
    process_env = {k: v for k, v in os.environ.items() if k not in env and not k.startswith("COMPOSE_")}
    compose = ["docker", "compose", "--env-file", str(DIRECTORY / ".env"), "-f", str(DIRECTORY / "compose.yaml")]

    def dc(*arguments, capture=False):
        return run([*compose, *arguments], capture=capture, env=process_env)

    dc("config", "--quiet", capture=True)
    image = env["KARAKEEP_IMAGE"]
    exists = run(["docker", "image", "inspect", image], capture=True, check=False).returncode == 0
    if args.build or image == "karakeep-custom:local" and not exists:
        dc("build", "web")
    elif args.pull or not exists:
        dc("pull", "web")
    # Bootstrap has no network or published ports and runs while public signup stays disabled.
    result = dc("run", "--rm", "--no-deps", "--pull", "never", "bootstrap", capture=True)
    initialized = json.loads(result.stdout.strip())
    print(initialized["message"] + ".")
    dc("up", "-d", "--no-build", "--pull", "missing")
    check_application(env, credentials, initialized["created"])
    print(f"URL: {env['NEXTAUTH_URL']}")
    print(f"Administrator: {credentials['email']}")
    print(f"Initial password is saved in {DIRECTORY / 'admin-credentials.json'} (mode 600).")
    print("Automatic AI processing is disabled. Configure your own API key to use AI features.")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, OSError, json.JSONDecodeError) as error:
        print(f"Deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
