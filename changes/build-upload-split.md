---
kind: fix
title: Safer app installs
---
App installs no longer run your generated app's code with your instance sign-in: Wayfinder builds the app in the sandbox, then uploads only the built package. Builds checkpoint only app source and project files; failed packaging or checkpoints cannot be installed.
