// Private from the first byte, including when replacing an older, more permissive file.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

/** OS-only ACL scripts run in Windows PowerShell, regardless of the launching shell's module paths. */
export function windowsAclShell() {
  const dir = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0");
  const env = { ...process.env };
  // Node passes only the first case-insensitive match when a Windows environment has duplicate keys.
  for (const key of Object.keys(env)) if (key.toLowerCase() === "psmodulepath") delete env[key];
  env.PSModulePath = join(dir, "Modules");
  return { executable: join(dir, "powershell.exe"), env };
}

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new Error("Expected a private directory");
  if (process.platform !== "win32") return chmod(path, 0o700);
  await ownerOnlyOnWindows(path);
}

/**
 * Closes a file that already exists, and its folder, to everyone but the current user. On Windows a folder's new
 * access list leaves the rules set on its files themselves, so the file gets its own, in the same ACL process.
 */
export async function privateFile(path: string): Promise<void> {
  const dir = dirname(path);
  if (!(await lstat(dir)).isDirectory() || !(await lstat(path)).isFile()) throw new Error("Expected a private file");
  if (process.platform === "win32") return ownerOnlyOnWindows(dir, path);
  await chmod(dir, 0o700);
  await chmod(path, 0o600);
}

// Replace the DACL instead of retaining explicit grants or inheriting from a shared parent.
async function ownerOnlyOnWindows(directory: string, file?: string): Promise<void> {
  const ownerOnly = (kind: "Directory" | "File", path: string) => [
    `$acl=[System.Security.AccessControl.${kind}Security]::new()`,
    "$acl.SetOwner($id)",
    "$acl.SetAccessRuleProtection($true,$false)",
    `$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($id,'FullControl',${kind === "Directory" ? "'ContainerInherit,ObjectInherit','None'," : ""}'Allow'))`,
    `[System.IO.${kind}]::SetAccessControl(${path},$acl)`,
  ];
  const script = [
    "$ErrorActionPreference='Stop'",
    "$id=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
    ...ownerOnly("Directory", "$env:SCARLET_PRIVATE_DIRECTORY"),
    ...(file ? ownerOnly("File", "$env:SCARLET_PRIVATE_FILE") : []),
  ].join(";");
  const shell = windowsAclShell();
  await promisify(execFile)(shell.executable, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...shell.env, SCARLET_PRIVATE_DIRECTORY: directory, SCARLET_PRIVATE_FILE: file ?? "" },
  });
}

export async function writePrivateFile(path: string, content: string): Promise<void> {
  const dir = dirname(path);
  await privateDirectory(dir);
  const temp = join(dir, `.private-${randomUUID()}`);
  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
