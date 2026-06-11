import { useEffect, useRef, useState } from "react";
import { spawn } from "node:child_process";
import {
  Action,
  ActionPanel,
  Clipboard,
  Detail,
  Form,
  Icon,
  Toast,
  getPreferenceValues,
  getSelectedFinderItems,
  openCommandPreferences,
  showHUD,
  showToast,
} from "@raycast/api";
import { bar, isFile, plan, transfer } from "./uploader";

interface Prefs {
  sshHost: string;
  remoteDir: string;
}

type Phase = "onboarding" | "select" | "uploading" | "done" | "error";

function testConnection(host: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/ssh", [
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=8",
      host,
      "echo ok",
    ]);
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => resolve(`error: ${e.message}`));
    child.on("close", (code) =>
      resolve(
        code === 0 && out.includes("ok")
          ? "ok"
          : (err || out).trim() || `exited ${code}`,
      ),
    );
  });
}

export default function Command() {
  const prefs = getPreferenceValues<Prefs>();
  const host = (prefs.sshHost || "").trim();
  const remoteDir = (prefs.remoteDir || "/tmp/raycast-uploads").trim();

  const [phase, setPhase] = useState<Phase>(host ? "select" : "onboarding");
  const [files, setFiles] = useState<string[]>([]);
  const [progress, setProgress] = useState(0);
  const [statusLine, setStatusLine] = useState("");
  const [remotePaths, setRemotePaths] = useState<string[]>([]);
  const [errorMsg, setErrorMsg] = useState("");
  const started = useRef(false);

  // Prefill the picker from the current Finder selection, if any.
  useEffect(() => {
    if (!host) return;
    (async () => {
      try {
        const items = await getSelectedFinderItems();
        const picked = items.map((i) => i.path).filter(isFile);
        if (picked.length) setFiles(picked);
      } catch {
        // No Finder selection — fine.
      }
    })();
  }, [host]);

  async function runTest() {
    if (!host) {
      await showToast({ style: Toast.Style.Failure, title: "No SSH host set" });
      return;
    }
    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Testing ${host}…`,
    });
    const res = await testConnection(host);
    if (res === "ok") {
      toast.style = Toast.Style.Success;
      toast.title = `Connected to ${host}`;
    } else {
      toast.style = Toast.Style.Failure;
      toast.title = "Connection failed";
      toast.message = res;
    }
  }

  async function upload(selected: string[]) {
    if (started.current) return;
    const { valid, targets } = plan(selected, remoteDir);
    if (valid.length === 0) {
      await showToast({
        style: Toast.Style.Failure,
        title: "No files selected",
      });
      return;
    }
    started.current = true;

    // Copy the remote path(s) to the clipboard right away.
    await Clipboard.copy(targets.join(" "));
    setRemotePaths(targets);
    setProgress(0);
    setPhase("uploading");

    const toast = await showToast({
      style: Toast.Style.Animated,
      title: `Uploading to ${host}`,
      message: bar(0),
    });

    try {
      await transfer(valid, targets, host, remoteDir, {
        onProgress: (pct) => {
          setProgress(pct);
          toast.message = bar(pct);
        },
        onStatus: setStatusLine,
      });
      setProgress(100);
      toast.style = Toast.Style.Success;
      toast.title =
        valid.length > 1 ? `Uploaded ${valid.length} files` : "Uploaded";
      toast.message = "Remote path copied to clipboard";
      setPhase("done");
      await showHUD("☁ Uploaded — remote path copied");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      toast.style = Toast.Style.Failure;
      toast.title = "Upload failed";
      toast.message = msg;
      setErrorMsg(msg);
      setPhase("error");
    }
  }

  if (phase === "onboarding") {
    const md = `# ☁️ VPS Upload

Upload files to your server over SSH and get the **remote path on your clipboard** — perfect for referencing local files inside a remote SSH session (e.g. an AI coding agent running on your VPS).

## Get started

1. **Set your server.** Open the command preferences (action below) and enter your **SSH Host** — an \`~/.ssh/config\` alias like \`vps\`, or \`user@host\` — and a **Remote Directory**.
2. **Make sure key-based login works** (no password prompt):
   \`\`\`
   ssh -o BatchMode=yes <host> true
   \`\`\`
   If that hangs or errors, set up an SSH key first.
3. **Use it:** select file(s) in Finder and run **Upload Finder Selection** (give it a hotkey!), or pick files in **Upload Files**.

_The remote path is copied to your clipboard the moment the upload starts._`;
    return (
      <Detail
        markdown={md}
        actions={
          <ActionPanel>
            <Action
              title="Open Preferences"
              icon={Icon.Gear}
              onAction={openCommandPreferences}
            />
            <Action
              title="Test Connection"
              icon={Icon.Bolt}
              onAction={runTest}
            />
          </ActionPanel>
        }
      />
    );
  }

  if (phase === "select") {
    return (
      <Form
        actions={
          <ActionPanel>
            <Action.SubmitForm
              title="Upload to Server"
              icon={Icon.Upload}
              onSubmit={(values: { files: string[] }) =>
                upload(values.files ?? files)
              }
            />
            <Action
              title="Test Connection"
              icon={Icon.Bolt}
              onAction={runTest}
            />
            <Action
              title="Open Preferences"
              icon={Icon.Gear}
              onAction={openCommandPreferences}
            />
          </ActionPanel>
        }
      >
        <Form.Description
          text={`Files upload to ${host}:${remoteDir} and the remote path is copied to your clipboard. Tip: select files in Finder and run "Upload Finder Selection" for a one-keystroke upload.`}
        />
        <Form.FilePicker
          id="files"
          title="Files"
          allowMultipleSelection
          value={files}
          onChange={setFiles}
        />
      </Form>
    );
  }

  const joined = remotePaths.join(" ");
  let markdown: string;
  if (phase === "uploading") {
    markdown = `# Uploading to \`${host}\`\n\n\`\`\`\n${bar(progress)}\n\`\`\`\n\n${statusLine}\n\n_Remote path (already on clipboard):_\n\n\`${joined}\``;
  } else if (phase === "done") {
    markdown = `# ✅ Upload complete\n\n\`\`\`\n${bar(100)}\n\`\`\`\n\nRemote path copied to clipboard:\n\n\`${joined}\``;
  } else {
    markdown = `# ❌ Upload failed\n\n\`\`\`\n${errorMsg}\n\`\`\`\n\nPartial remote path: \`${joined}\``;
  }

  return (
    <Detail
      markdown={markdown}
      actions={
        phase !== "uploading" ? (
          <ActionPanel>
            {phase === "done" && (
              <Action.CopyToClipboard
                title="Copy Remote Path Again"
                content={joined}
              />
            )}
            <Action
              title="Open Preferences"
              icon={Icon.Gear}
              onAction={openCommandPreferences}
            />
          </ActionPanel>
        ) : undefined
      }
    />
  );
}
