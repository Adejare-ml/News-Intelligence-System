# Contributing Guidelines

Thank you for considering contributing to this repository!

## How to Contribute
1. Fork the repository.
2. Create a feature branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add amazing feature'`).
4. Push to your branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

## Reporting Bugs
Please use the issue tracker to report bugs. Include a detailed description and
steps to reproduce.

## Running the tests
The Python suite and the headless frontend suite both run without a browser:

```bash
pip install -r requirements-ci.txt pytest
pytest -q
node tests/frontend/run.js
```
