# Contributing to DurakBot

Thank you for your interest in DurakBot. Bug reports, rule questions, new bots, analysis of the champion's play, translations and improvements to the code or the documentation are all welcome.

## Reporting a problem

Open an issue on GitHub with:

- what you did and what you expected;
- for a game in the web app, the **seed** shown on the game-over sheet, the number of players and the opponents, so the deal can be reproduced;
- for a rules question, the position (hands, trump, table) and the move in question. [docs/RULES.md](docs/RULES.md) describes the rules exactly as implemented, and some house rules are deliberately not supported.

## Making a change

1. Set up the environment as described in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
2. Make the change on a branch, with tests. Changes to the rules engine, the solver or the encoder need a test that compares against the engine or a brute-force reference; new bots need a test that they use only the information their seat is entitled to ([docs/BOTS.md](docs/BOTS.md#no-cheating-guarantees)).
3. Run the tests: `.venv/bin/python -m pytest -q`, and for front-end changes `npm run typecheck` in `web/` and the browser tests (`tests/test_server_e2e.py`).
4. Update the documentation in `docs/` if behaviour, commands or file formats change.
5. Open a pull request that explains what changed and why. For strength claims, include the evaluation command and its output with confidence intervals ([docs/EVALUATION.md](docs/EVALUATION.md)).

Please keep pull requests focused: one bug fix, feature or experiment per pull request is easier to review.

## Guidelines

- Follow the conventions in [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md#conventions): integer card masks, a single source of truth for the rules, seeded randomness, and no hidden information for bots.
- User-visible text in the web app needs both an English and a Russian string.
- New artwork must be original or carry a licence compatible with the project's, recorded in `web/public/assets/LICENSES.md` or the relevant manifest ([docs/ART.md](docs/ART.md#licences)).
- Large binary files (checkpoints, renders, screenshots) should only be committed when they are needed at run time.

## Licence

By contributing, you agree that your contributions are licensed under the project's [MIT licence](LICENSE).
