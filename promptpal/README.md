# Tauri + React + Typescript

This template should help get you started developing with Tauri, React and Typescript in Vite.

## Stage 1 Safety Baseline

**Release:** PromptPal Stage 1 Safety Baseline (v0.1.0-pilot)  
**Approval date:** October 4, 2026  
**Approver:** Rod Geryk Cansanay Navarro

Stage 1 does not satisfy the original full MVP scope. The pilot workflow is **Paste -> Select Template -> Edit -> Copy -> Manually Paste into ChatGPT**. Users must manually copy and paste in both directions; the floating UI operates strictly as an isolated notepad. Automatic capture (FR02) and insertion (FR07) are deferred because standard Windows UIA APIs do not provide secure, live-verifiable control identity or webpage-origin authentication.

The pilot targets 10-15 students. Success is measured by at least 80% of participants completing the manual workflow without assistance, a target one-point median improvement in Context, Task, and Format usage, and manual-workflow friction recorded through consented observation and feedback. Results must state the small-sample limitation; no hidden telemetry is collected.

The "19/20 successful native insertion trials" metric is preserved in the master PRD as an untested, deferred FR07 gate. After the pilot, evaluate manual-workflow friction against the architectural cost and deployment complexity of a browser extension for secure DOM verification.

Privacy and operations: there is no default prompt history, prompt content is not written to logs or persistent files, and Clear Data requires confirmation. The setup guide, known limitations, and troubleshooting guidance are part of the pilot documentation. CLEAR removes application references to volatile text and causes the rendered UI to clear on the next React commit; JavaScript garbage collection and React internals do not guarantee secure memory erasure or immediate destruction of every string.

### Pilot Setup

Install the desktop build on Windows, launch PromptPal, paste the source prompt into the capture field, select a template, edit it, and use the explicit Copy action to transfer the result manually. UIA diagnostics require both `uia-diagnostics` and `VITE_UIA_DIAGNOSTICS=true`; they are not part of the pilot workflow.

### Limitations and Troubleshooting

PromptPal does not authenticate browser origin, read browser selections, insert text, maintain default prompt history, or collect hidden telemetry. If a shortcut does not bring the window forward, verify the global shortcut is available and restart the app. If storage becomes read-only, use Clear Data only after confirming the destructive prompt, then restart the app if the warning persists. Windows 11 validation remains pending until a validation device is available.

## Recommended IDE Setup

- [VS Code](https://code.visualstudio.com/) + [Tauri](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer)
