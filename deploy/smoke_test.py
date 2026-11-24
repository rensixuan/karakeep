#!/usr/bin/env python3
"""Exercise a disposable deployment, including persisted content across a second startup."""
import hashlib
import http.cookiejar
import json
from pathlib import Path
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

import deploy


def main():
    env = deploy.read_env(deploy.DIRECTORY / ".env")
    if not env["COMPOSE_PROJECT_NAME"].startswith(("portable-test-", "portable-ci-")):
        raise RuntimeError("Smoke test requires a disposable portable-test-/portable-ci- project")
    credentials = json.loads((deploy.DIRECTORY / "admin-credentials.json").read_text())
    before = {name: hashlib.sha256((deploy.DIRECTORY / name).read_bytes()).hexdigest()
              for name in [".env", "admin-credentials.json"]}
    origin = f"http://127.0.0.1:{env['WEB_PORT']}"
    cookies = http.cookiejar.CookieJar()
    client = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(cookies))

    def request(route, data=None, method=None, content_type="application/json"):
        body = data if isinstance(data, bytes) else json.dumps(data).encode() if data is not None else None
        req = urllib.request.Request(origin + route, data=body, method=method,
            headers={"Content-Type": content_type, "Origin": env["NEXTAUTH_URL"]})
        with client.open(req, timeout=30) as response:
            return json.loads(response.read() or b"null")

    request("/api/auth/sign-in/email", {**credentials, "rememberMe": False})
    identifier = None
    try:
        try:
            request("/api/auth/sign-up/email", {
                "name": "Denied", "email": "signup-denied@example.com", "password": uuid.uuid4().hex,
            })
        except urllib.error.HTTPError as error:
            assert error.code in {400, 403}, f"Unexpected signup rejection: {error.code}"
        else:
            raise RuntimeError("Public signup was unexpectedly enabled")
        boundary = "portable" + uuid.uuid4().hex
        phrase = "Portable deployment 中文正文 😀"
        html = f"<!doctype html><html><head><meta charset='utf-8'><title>Deployment check</title></head><body><article><h1>Deployment check</h1><p>{phrase}</p><p>This archived article validates extraction without accessing an external page.</p></article></body></html>"
        payload = (f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="check.html"\r\n'
                   f'Content-Type: text/html\r\n\r\n{html}\r\n--{boundary}--\r\n').encode()
        asset = request("/api/v1/assets", payload, content_type=f"multipart/form-data; boundary={boundary}")
        bookmark = request("/api/v1/bookmarks", {
            "type": "link", "url": "https://example.com/deployment-check-" + uuid.uuid4().hex,
            "title": "Portable deployment check", "precrawledArchiveId": asset["assetId"],
            "source": "import", "crawlPriority": "low",
        })
        identifier = bookmark["id"]
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            item = request(f"/api/v1/bookmarks/{identifier}?includeContent=true")
            if item["content"].get("crawlStatus") == "success":
                break
            if item["content"].get("crawlStatus") == "failure":
                raise RuntimeError("Fresh-install article extraction failed")
            time.sleep(2)
        assert phrase in item["content"].get("htmlContent", ""), "Reader body not preserved"
        query = urllib.parse.quote(json.dumps({"json": {"bookmarkId": identifier}}))
        reader = request("/api/trpc/translations.get?input=" + query)["result"]["data"]["json"]
        assert reader["segments"] and reader["encryptionAvailable"], "Custom translation feature missing"
        # Run the same user entry point again: existing accounts, secrets and volumes must survive.
        subprocess.run([
            sys.executable, str(deploy.DIRECTORY / "deploy.py"),
            "--project-name", env["COMPOSE_PROJECT_NAME"], "--url", env["NEXTAUTH_URL"],
            "--image", env["KARAKEEP_IMAGE"],
        ], check=True)
        for name, digest in before.items():
            assert hashlib.sha256((deploy.DIRECTORY / name).read_bytes()).hexdigest() == digest
        assert request(f"/api/v1/bookmarks/{identifier}")["id"] == identifier
        print("PASS: disabled signup, archived Chinese/emoji content, translation segments, repeat startup and persistent data.")
    finally:
        if identifier:
            request(f"/api/v1/bookmarks/{identifier}", method="DELETE")
        request("/api/auth/sign-out", {})


if __name__ == "__main__":
    main()
