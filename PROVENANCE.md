# Source provenance

The initial source export is from local repository `dsh-web-selfuse`, commit `f933724` (installer support), whose parent is `ec79ee5`. The exported paths are the three package workspaces, workspace lock/config files, and the headless installer, installer tests, and schema probe. The original repository and its Git history are retained locally, unchanged by this export.

The web capability implementation originated in [deepseek-harness/deepseek-harness#2294](https://github.com/deepseek-harness/deepseek-harness/pull/2294), commit `74c99cf165a9e95fcaa677f5462f3f648be3c74b`. This repository preserves the extended model-facing tool rather than depending on that PR's release packaging or GUI changes. It is not a claim of synchronization with the latest upstream branch.

Earlier self-use evidence records a real-model POST to `https://httpbin.org/post`, returning HTTP 200 and echoing the test Authorization header and serialized JSON body. Those transcripts and GUI screenshots are not exported. Current automated tests are loopback transport and profile-composition checks, not substitutes for a new real-model round.

The source commit's [MIT license](https://github.com/deepseek-harness/deepseek-harness/blob/74c99cf165a9e95fcaa677f5462f3f648be3c74b/LICENSE) permits redistribution with its copyright and permission notice. This repository includes that notice in [LICENSE](LICENSE). Dependency compatibility and installation on registry-only hosts remain unverified. All workspace packages stay `private: true`; public source availability does not publish packages under upstream's npm names.
