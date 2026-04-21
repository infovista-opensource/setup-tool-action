# Changes since fork

- use temporary directory for downloading tool to avoid execution issues in containerized runner
- bumped dependencies
- in containers, download tools but do not use toolcache that messes up with file ownership. instead, use ~/.local/bin
