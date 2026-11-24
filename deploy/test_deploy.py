import argparse
import base64
import contextlib
import io
import json
from pathlib import Path
import shutil
import stat
import subprocess
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import deploy


class DeploymentTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.directory = Path(self.temp.name)
        shutil.copyfile(deploy.DIRECTORY / ".env.example", self.directory / ".env.example")
        self.args = argparse.Namespace(url=None, email=None, image=None, project_name=None)

    def tearDown(self):
        self.temp.cleanup()

    def test_first_install_generates_independent_secrets_and_private_credentials(self):
        env, credentials = deploy.prepare(self.directory, self.args)
        self.assertEqual(len(base64.b64decode(env["TRANSLATION_ENCRYPTION_KEY"])), 32)
        self.assertNotEqual(env["NEXTAUTH_SECRET"], env["MEILI_MASTER_KEY"])
        self.assertGreaterEqual(len(credentials["password"]), 24)
        self.assertEqual(env["DISABLE_SIGNUPS"], "true")
        self.assertEqual(env["INFERENCE_ENABLE_AUTO_SUMMARIZATION"], "false")
        self.assertEqual(env["OPENAI_API_KEY"], "")
        for name in [".env", "admin-credentials.json"]:
            self.assertEqual(stat.S_IMODE((self.directory / name).stat().st_mode), 0o600)
        self.assertEqual(deploy.read_env(self.directory / ".env"), env)

    def test_rerun_preserves_password_and_all_keys_byte_for_byte(self):
        first = deploy.prepare(self.directory, self.args)
        before = {name: (self.directory / name).read_bytes() for name in [".env", "admin-credentials.json"]}
        self.assertEqual(deploy.prepare(self.directory, self.args), first)
        self.assertEqual(before, {name: (self.directory / name).read_bytes() for name in before})

    def test_rerun_does_not_silently_change_identity_url_or_image(self):
        deploy.prepare(self.directory, self.args)
        for key, value in [("url", "https://other.example.com"), ("email", "other@example.com"),
                           ("image", "another:version"), ("project_name", "another")]:
            with self.subTest(key=key):
                args = argparse.Namespace(**vars(self.args))
                setattr(args, key, value)
                with self.assertRaises(ValueError):
                    deploy.prepare(self.directory, args)

    def test_missing_credential_file_is_not_regenerated(self):
        deploy.prepare(self.directory, self.args)
        (self.directory / "admin-credentials.json").unlink()
        with self.assertRaisesRegex(ValueError, "Restore"):
            deploy.prepare(self.directory, self.args)
        self.assertFalse((self.directory / "admin-credentials.json").exists())

    def test_https_is_optional_and_http_uses_requested_port(self):
        https = deploy.url_settings("https://reader.example.com/")
        self.assertEqual(https["COMPOSE_PROFILES"], "https")
        self.assertEqual(https["WEB_BIND"], "127.0.0.1")
        self.assertEqual(https["CADDY_SITE"], "reader.example.com")
        remote = deploy.url_settings("http://192.0.2.10:3100")
        self.assertEqual(remote["WEB_BIND"], "0.0.0.0")
        self.assertEqual(remote["WEB_PORT"], "3100")
        self.assertEqual(remote["COMPOSE_PROFILES"], "")
        for url in ["ftp://example.com", "https://u:p@example.com", "https://example.com/path",
                    "https://example.com?x=1", "https://example.com:444", "https://bad{$DOMAIN}.com"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                deploy.url_settings(url)

    def test_placeholder_secrets_cannot_be_used_as_production_values(self):
        deploy.prepare(self.directory, self.args)
        file = self.directory / ".env"
        env = deploy.read_env(file)
        file.write_text(file.read_text().replace(env["NEXTAUTH_SECRET"], "GENERATED_BY_DEPLOY_SCRIPT"))
        with self.assertRaisesRegex(ValueError, "NEXTAUTH_SECRET"):
            deploy.prepare(self.directory, self.args)

    def test_existing_project_elsewhere_is_never_touched(self):
        response = [subprocess.CompletedProcess([], 0, "container-id\n"),
                    subprocess.CompletedProcess([], 0, json.dumps([{"Config": {"Labels": {
                        "com.docker.compose.project.working_dir": "/some/other/installation"}}}]))]
        with patch.object(deploy, "run", side_effect=response), self.assertRaisesRegex(ValueError, "already used"):
            deploy.check_project("karakeep", True)

    def test_existing_data_without_secrets_requires_restore(self):
        response = [subprocess.CompletedProcess([], 0, ""), subprocess.CompletedProcess([], 0, "[]")]
        with patch.object(deploy, "run", side_effect=response), self.assertRaisesRegex(ValueError, "restore its secrets"):
            deploy.check_project("karakeep", False)

    def test_captured_command_failure_does_not_leak_output(self):
        failure = subprocess.CompletedProcess([], 1, "sensitive-output", "sensitive-error")
        with patch.object(subprocess, "run", return_value=failure):
            with self.assertRaises(RuntimeError) as raised, contextlib.redirect_stdout(io.StringIO()):
                deploy.run(["docker", "compose", "config"], capture=True)
        self.assertNotIn("sensitive", str(raised.exception))

    def test_cold_start_connection_reset_is_retried(self):
        ready = MagicMock()
        ready.__enter__.return_value.status = 200
        with patch.object(deploy.urllib.request, "urlopen", side_effect=[ConnectionResetError(), ready]) as request:
            with patch.object(deploy.time, "sleep"):
                deploy.wait_for_health("http://127.0.0.1:3000")
        self.assertEqual(request.call_count, 2)

    def test_invalid_initial_project_name_does_not_create_credentials(self):
        self.args.project_name = "bad/name"
        with self.assertRaises(ValueError):
            deploy.prepare(self.directory, self.args)
        self.assertFalse((self.directory / "admin-credentials.json").exists())


if __name__ == "__main__":
    unittest.main()
