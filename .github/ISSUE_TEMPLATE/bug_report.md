name: Bug Report
description: File a bug report for Canvas Card
title: "[Bug]: "
labels: ["bug"]
body:
  - type: markdown
    attributes:
      value: Thanks for taking the time to report this issue!
  - type: input
    id: version
    attributes:
      label: Canvas Card Version
      description: What version of Canvas Card are you running? (e.g. v1.0.0)
    validations:
      required: true
  - type: input
    id: ha_version
    attributes:
      label: Home Assistant Version
      description: What version of Home Assistant are you running? (e.g. 2024.10)
    validations:
      required: true
  - type: input
    id: browser
    attributes:
      label: Browser / Client Environment
      description: What browser or app are you using? (e.g. Chrome 129, iOS Safari, HA Companion App)
    validations:
      required: true
  - type: textarea
    id: description
    attributes:
      label: Description of the Bug
      description: A clear and concise description of what the bug is.
    validations:
      required: true
  - type: textarea
    id: repro
    attributes:
      label: Steps to Reproduce
      description: Steps to reproduce the behavior.
    validations:
      required: true
  - type: textarea
    id: expected
    attributes:
      label: Expected Behavior
      description: A clear and concise description of what you expected to happen.
    validations:
      required: false
