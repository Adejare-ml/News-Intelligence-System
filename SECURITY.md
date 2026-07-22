# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| main    | Yes       |

## Reporting a Vulnerability

Email adelugbaadejare03@gmail.com with:

- Description of the vulnerability
- Steps to reproduce
- Expected vs actual behavior

You will get a response within 72 hours. Do not open a public issue for security problems.

## Known Considerations

- This application handles JWT authentication. Keep your JWT_SECRET strong and rotated.
- API keys for news providers should stay in .env files, never in source code.
- The Docker Compose setup uses environment variable references. Do not hardcode credentials.