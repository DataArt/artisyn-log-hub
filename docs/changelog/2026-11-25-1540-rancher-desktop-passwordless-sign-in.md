# Passwordless sign-in works after install on Rancher Desktop

- With `AUTH_MODE=none` the installers now check, right after starting the app, that this machine can sign in. When the Docker runtime delivers the browser's requests from an unexpected address (Rancher Desktop on Windows: `192.168.127.1`), they add it to the new `AUTH_NONE_TRUSTED_PEERS` setting in `.env` and restart the app. Re-running the installer fixes an existing install.
- When the login page refuses an email as not local, it now names the address the server saw and how to fix it, instead of "Could not continue with that email".
