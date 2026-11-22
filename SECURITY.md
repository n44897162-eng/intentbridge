# Security

IntentBridge is a local-first tool. The default shell binds to `127.0.0.1`,
requires a one-time session token, rejects cross-site API requests, and stores
secrets encrypted with a per-install key. It does not upload flows, screenshots
or secrets to any cloud service.

## Reporting

Please use GitHub's **private security advisory** feature for this repository
(Security → Report a vulnerability). Do not open a public issue with exploit
details, tokens, recordings or personal data.

Include:

- affected version/commit,
- platform and reproduction steps,
- whether the issue is a secret disclosure, scope escape, evidence path issue,
  or local privilege boundary bypass.

## Known boundaries

- Windows UIA and Android accessibility runtime paths are compiled but have not
  been verified on their target OS in this repository's CI.
- The browser extension asks for site permissions explicitly; a test build may
  grant `<all_urls>` only in tests.
- `secret://` aliases are resolved from the local secret store; missing aliases
  fail closed.
- Uploading recordings of third-party applications is outside this project's
  threat model.
