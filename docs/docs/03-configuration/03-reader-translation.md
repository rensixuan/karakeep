# Reader translation

The web article preview and full-screen reader can display saved articles with
Simplified Chinese translations beneath the original paragraphs. Translation
uses each user's own OpenAI account, independently of auto-tagging and summaries.

## Server setup

Back up the SQLite database before deploying the new version and applying its
normal database migrations. Migration `0098_reader_translations` adds encrypted
user credentials and translation caches without modifying existing articles.

Set `TRANSLATION_ENCRYPTION_KEY` on the web server to a **base64-encoded random
32-byte key**. Generate it once using a password manager / secret manager, or
`openssl rand -base64 32`, and store it in your deployment's secret configuration.
Do not commit it, put it in a public environment variable, or save it in SQLite.
The feature fails closed when this setting is missing or malformed; existing
reading features and cached translations remain available.

Persist this key across container restarts, upgrades and restores. Back it up
separately from the database, with restricted access. Changing or losing it makes
existing provider credentials unreadable. This first version has no automatic
master-key rotation: restore the original key, or have users save their provider
keys again after replacing it. Never generate a fresh master key at startup.

Serve the application over HTTPS and set `NEXTAUTH_URL` to its HTTPS URL. The
production server rejects credential saves if its configured URL is not HTTPS.
Plain HTTP on localhost is supported only for local development. Ensure reverse
proxies/APM tooling do not record request bodies or authorization headers.

## User setup and operation

In **Settings → AI → Reading translation**, save an OpenAI API key and model
(`gpt-5.4-mini` by default). Keys are encrypted with AES-256-GCM, a fresh 12-byte
nonce, and user-bound authenticated data. Only the server decrypts them for API
calls. Saved keys cannot be displayed; users may replace or delete them.

**Test saved connection** makes a small translation request using the saved
configuration. Tests and article translations consume the user's OpenAI API
credits. Requests use `https://api.openai.com/v1` and Chat Completions with
structured outputs; the selected model must support these features. Provider
request storage is disabled. Global inference URLs, keys and logging settings
do not override the translation client.

Choose **Translate to Chinese** in the reader. Completed batches are saved and
shown immediately. Pause, hide the translation, leave the reader, or switch to
another browser tab to stop scheduling new batches. An already dispatched batch
can finish and be saved. Reopening an article displays cached translations without
starting new paid work; choose **Continue translation** to finish missing parts.

**Translate again** clears the current cache and starts a new generation. Article
or model changes invalidate the cache, and stale responses cannot replace the new
generation. Original highlights and reading positions use only original text.
Translated text is readable and copyable but cannot itself be highlighted.

Only signed-in bookmark owners can use this feature. It does not translate PDFs,
screenshots, public shared readers, or native mobile apps, and does not schedule
background translation jobs. The server records only bounded error codes, never
provider error bodies, keys or article prompts.
