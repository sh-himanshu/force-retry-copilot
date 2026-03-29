import * as vscode from "vscode";

const ERROR_PATTERN = "[error] Error: Error during execution";
const RESET_WINDOW_MS = 60_000;

let enabled = true;
let lastRetryAt = 0;
let consecutiveRetries = 0;
let maxRetries = 3; // runtime value, changed via menu
let statusBarItem: vscode.StatusBarItem;
let outputLog: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputLog = vscode.window.createOutputChannel("Force Retry Copilot");

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBarItem.command = "force-retry-copilot.showMenu";
  updateStatusBar();
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // QuickPick menu on status bar click
  context.subscriptions.push(
    vscode.commands.registerCommand("force-retry-copilot.showMenu", async () => {
      if (!enabled) {
        // When OFF — offer to turn on
        const pick = await vscode.window.showQuickPick(
          [
            { label: "$(play) Turn ON", description: "Normal retry (max 3)", id: "on-normal" },
            { label: "$(play) Turn ON — Custom", description: "Choose max retries", id: "on-custom" },
          ],
          { title: "Force Retry Copilot", placeHolder: "Currently OFF" }
        );
        if (!pick) return;

        if (pick.id === "on-normal") {
          maxRetries = 3;
          enabled = true;
          consecutiveRetries = 0;
          updateStatusBar();
          log("Enabled — normal mode (max 3)");
        } else if (pick.id === "on-custom") {
          const chosen = await pickCustomMax();
          if (chosen === undefined) return;
          maxRetries = chosen;
          enabled = true;
          consecutiveRetries = 0;
          updateStatusBar();
          log(`Enabled — custom mode (max ${maxRetries})`);
        }
      } else {
        // When ON — show current mode, offer to switch or turn off
        const modeLabel = maxRetries === 0 ? "unlimited" : `max ${maxRetries}`;
        const pick = await vscode.window.showQuickPick(
          [
            { label: "$(primitive-square) Turn OFF", description: "", id: "off" },
            { label: "$(settings) Normal Retry", description: "max 3 retries", id: "normal" },
            { label: "$(settings-gear) Custom Retry", description: "Choose max retries", id: "custom" },
          ],
          { title: "Force Retry Copilot", placeHolder: `Currently ON — ${modeLabel} | retries: ${consecutiveRetries}` }
        );
        if (!pick) return;

        if (pick.id === "off") {
          enabled = false;
          consecutiveRetries = 0;
          updateStatusBar();
          log("Disabled");
        } else if (pick.id === "normal") {
          maxRetries = 3;
          consecutiveRetries = 0;
          updateStatusBar();
          log("Switched to normal mode (max 3)");
        } else if (pick.id === "custom") {
          const chosen = await pickCustomMax();
          if (chosen === undefined) return;
          maxRetries = chosen;
          consecutiveRetries = 0;
          updateStatusBar();
          log(`Switched to custom mode (max ${maxRetries})`);
        }
      }
    })
  );

  // Monitor output channel documents for the Copilot error
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument(async (event) => {
      if (!enabled) return;
      if (event.document.uri.scheme !== "output") return;

      for (const change of event.contentChanges) {
        if (!change.text.includes(ERROR_PATTERN)) continue;

        const config = vscode.workspace.getConfiguration("forceRetryCopilot");
        const debounceMs = config.get<number>("debounceMs", 5000);
        const retryMessage = config.get<string>("retryMessage", "try again");
        const now = Date.now();

        // Reset consecutive counter after a quiet period
        if (now - lastRetryAt > RESET_WINDOW_MS) {
          consecutiveRetries = 0;
        }

        // Debounce
        if (now - lastRetryAt < debounceMs) {
          log("Error detected but debounce active — skipping");
          return;
        }

        // Max retries check
        if (maxRetries > 0 && consecutiveRetries >= maxRetries) {
          log(`Max retries (${maxRetries}) reached — pausing`);
          enabled = false;
          updateStatusBar();
          vscode.window.showWarningMessage(
            `Force Retry Copilot: Paused after ${maxRetries} retries. Click status bar to re-enable.`
          );
          return;
        }

        lastRetryAt = now;
        consecutiveRetries++;
        updateStatusBar();

        log(`Error detected — sending retry #${consecutiveRetries}...`);

        try {
          await sendRetry(retryMessage);
          log(`Retry #${consecutiveRetries} sent`);
        } catch (err) {
          log(`Failed to send retry: ${err}`);
        }

        break;
      }
    })
  );

  log("Activated — monitoring Copilot Chat output for errors");
}

async function pickCustomMax(): Promise<number | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "3", description: "retries", id: 3 },
      { label: "5", description: "retries", id: 5 },
      { label: "10", description: "retries", id: 10 },
      { label: "20", description: "retries", id: 20 },
      { label: "Unlimited", description: "no limit (0)", id: 0 },
    ],
    { title: "Max Retries", placeHolder: "How many retries before pausing?" }
  );
  return pick?.id;
}

async function sendRetry(message: string) {
  await vscode.commands.executeCommand("workbench.action.chat.open", {
    query: message,
  });
  await new Promise((r) => setTimeout(r, 500));
  await vscode.commands.executeCommand("workbench.action.chat.acceptInput");
}

function updateStatusBar() {
  if (!enabled) {
    statusBarItem.text = "$(circle-slash) Force Retry OFF";
    statusBarItem.backgroundColor = undefined;
  } else if (consecutiveRetries > 0) {
    const modeLabel = maxRetries === 0 ? "unlimited" : `${consecutiveRetries}/${maxRetries}`;
    statusBarItem.text = `$(sync~spin) Force Retry (${modeLabel})`;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      "statusBarItem.warningBackground"
    );
  } else {
    const modeLabel = maxRetries === 0 ? "unlimited" : `max ${maxRetries}`;
    statusBarItem.text = `$(check) Force Retry ON — ${modeLabel}`;
    statusBarItem.backgroundColor = undefined;
  }
  statusBarItem.tooltip = "Click for options";
}

function log(msg: string) {
  outputLog.appendLine(`[${new Date().toISOString()}] ${msg}`);
}

export function deactivate() {}
