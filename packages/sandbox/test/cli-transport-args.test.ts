import { describe, expect, it } from "vitest";
import {
  buildCreateArgs,
  buildLocalForwardArgs,
  buildSshArgs,
  parsePresetList,
  parsePresetsOutput,
  parseWorkspaceRef,
  parseWorkspaceStatus,
  type SshArgsOptions,
  sshHostAlias,
} from "../src/cli-transport.js";

const opts = (over: Partial<SshArgsOptions> = {}): SshArgsOptions => ({
  coderBinary: "coder",
  loginShell: true,
  waitMode: "no",
  silenceProxyStderr: true,
  ...over,
});

describe("buildSshArgs (OpenSSH via coder --stdio ProxyCommand)", () => {
  it("builds a ProxyCommand-based OpenSSH invocation", () => {
    const args = buildSshArgs("ws", "echo hi", opts());
    expect(args).toEqual([
      "-o",
      "ProxyCommand='coder' ssh --stdio --wait=no 'ws' 2>/dev/null",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-T",
      "coder.ws",
      "bash -lc 'echo hi'",
    ]);
  });

  it("passes the remote command as a single, fully-quoted argument", () => {
    const args = buildSshArgs("ws", "echo a; echo b", opts());
    expect(args[args.length - 1]).toBe("bash -lc 'echo a; echo b'");
  });

  it("uses bash -c when loginShell is false", () => {
    const args = buildSshArgs("ws", "x", opts({ loginShell: false }));
    expect(args[args.length - 1]).toBe("bash -c 'x'");
  });

  it("honors waitMode and a custom coder binary", () => {
    const args = buildSshArgs("ws", "x", opts({ waitMode: "auto", coderBinary: "/usr/bin/coder" }));
    expect(args[1]).toBe("ProxyCommand='/usr/bin/coder' ssh --stdio --wait=auto 'ws' 2>/dev/null");
  });

  it("omits stderr redirection when silenceProxyStderr is false", () => {
    const args = buildSshArgs("ws", "x", opts({ silenceProxyStderr: false }));
    expect(args[1]).toBe("ProxyCommand='coder' ssh --stdio --wait=no 'ws'");
  });

  it("shell-quotes a coder binary path and workspace ref with shell-special chars", () => {
    const args = buildSshArgs("we'rd ws", "x", opts({ coderBinary: "/opt/my coder" }));
    expect(args[1]).toBe(
      "ProxyCommand='/opt/my coder' ssh --stdio --wait=no 'we'\\''rd ws' 2>/dev/null",
    );
  });
});

describe("sshHostAlias", () => {
  it("prefixes coder. and sanitizes owner/agent separators", () => {
    expect(sshHostAlias("ws")).toBe("coder.ws");
    expect(sshHostAlias("owner/ws.agent")).toBe("coder.owner-ws.agent");
  });
});

describe("buildLocalForwardArgs", () => {
  it("builds an OpenSSH -L forward over a coder --stdio ProxyCommand", () => {
    expect(
      buildLocalForwardArgs("ws", 12345, 4000, {
        coderBinary: "coder",
        waitMode: "no",
        silenceProxyStderr: true,
      }),
    ).toEqual([
      "-o",
      "ProxyCommand='coder' ssh --stdio --wait=no 'ws' 2>/dev/null",
      "-o",
      "StrictHostKeyChecking=no",
      "-o",
      "UserKnownHostsFile=/dev/null",
      "-o",
      "LogLevel=ERROR",
      "-o",
      "ExitOnForwardFailure=yes",
      "-N",
      "-L",
      "12345:127.0.0.1:4000",
      "coder.ws",
    ]);
  });
});

describe("buildCreateArgs", () => {
  it("builds a minimal non-interactive create", () => {
    expect(buildCreateArgs({ workspace: "ws", template: "docker" })).toEqual([
      "create",
      "ws",
      "--yes",
      "--template",
      "docker",
    ]);
  });

  it("includes version, preset, params, file, defaults, ephemeral, ttl, updates, org", () => {
    const args = buildCreateArgs({
      workspace: "alice/ws",
      template: "docker",
      templateVersion: "v2",
      preset: "Large",
      parameters: { cpus: "8", region: "us-west-2" },
      parameterFile: "./params.yaml",
      useParameterDefaults: true,
      ephemeralParameters: { force: "true" },
      stopAfter: "8h",
      automaticUpdates: "always",
      org: "engineering",
    });
    expect(args).toEqual([
      "create",
      "alice/ws",
      "--yes",
      "--template",
      "docker",
      "--template-version",
      "v2",
      "--preset",
      "Large",
      "--parameter",
      "cpus=8",
      "--parameter",
      "region=us-west-2",
      "--rich-parameter-file",
      "./params.yaml",
      "--use-parameter-defaults",
      "--ephemeral-parameter",
      "force=true",
      "--stop-after",
      "8h",
      "--automatic-updates",
      "always",
      "--org",
      "engineering",
    ]);
  });

  it("passes --preset none through verbatim", () => {
    const args = buildCreateArgs({ workspace: "ws", template: "docker", preset: "none" });
    expect(args).toContain("--preset");
    expect(args[args.indexOf("--preset") + 1]).toBe("none");
  });
});

describe("parseWorkspaceRef", () => {
  it("defaults the owner to me", () => {
    expect(parseWorkspaceRef("ws")).toEqual({ owner: "me", name: "ws" });
  });
  it("splits owner/name", () => {
    expect(parseWorkspaceRef("alice/ws")).toEqual({ owner: "alice", name: "ws" });
  });
  it("strips an agent suffix from the name", () => {
    expect(parseWorkspaceRef("alice/ws.main")).toEqual({ owner: "alice", name: "ws" });
  });
  it("parses an owner/name.agent reference", () => {
    expect(parseWorkspaceRef("owner/ws.agent")).toEqual({ owner: "owner", name: "ws" });
  });
  it("parses a bare name.agent reference (owner defaults to me)", () => {
    expect(parseWorkspaceRef("ws.main")).toEqual({ owner: "me", name: "ws" });
  });

  const expected = /invalid workspace reference ".*"; expected \[owner\/\]name\[\.agent\]/;
  it("throws on a reference with more than one slash", () => {
    expect(() => parseWorkspaceRef("a/b/c")).toThrow(expected);
  });
  it("throws on an empty name after the slash", () => {
    expect(() => parseWorkspaceRef("owner/")).toThrow(expected);
  });
  it("throws on an empty agent-only reference", () => {
    expect(() => parseWorkspaceRef(".main")).toThrow(expected);
  });
  it("throws on a name with illegal characters", () => {
    expect(() => parseWorkspaceRef("bad name!")).toThrow(expected);
  });
  it("throws on a name that does not start alphanumeric", () => {
    expect(() => parseWorkspaceRef("-leading")).toThrow(expected);
  });
});

describe("parseWorkspaceStatus", () => {
  it("extracts build status, transition, and agents from a list entry", () => {
    const status = parseWorkspaceStatus({
      name: "ws",
      latest_build: {
        status: "running",
        transition: "start",
        resources: [
          { agents: [{ name: "main", status: "connected", lifecycle_state: "ready" }] },
          { agents: [] },
        ],
      },
    });
    expect(status).toEqual({
      name: "ws",
      buildStatus: "running",
      transition: "start",
      agents: [{ name: "main", status: "connected", lifecycleState: "ready" }],
    });
  });

  it("tolerates missing fields", () => {
    const status = parseWorkspaceStatus({});
    expect(status.buildStatus).toBe("pending");
    expect(status.transition).toBe("start");
    expect(status.agents).toEqual([]);
  });

  it("surfaces the workspace UUID when the CLI reports one", () => {
    const status = parseWorkspaceStatus({
      id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      name: "ws",
      latest_build: { status: "running", transition: "start", resources: [] },
    });
    expect(status.id).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("omits id for old CLIs that don't report one (or report a non-string)", () => {
    expect("id" in parseWorkspaceStatus({ name: "ws" })).toBe(false);
    expect(parseWorkspaceStatus({ id: 42, name: "ws" }).id).toBeUndefined();
    expect(parseWorkspaceStatus({ id: "", name: "ws" }).id).toBeUndefined();
  });
});

describe("parsePresetList", () => {
  it("unwraps the PascalCase TemplatePreset shape from the CLI", () => {
    const presets = parsePresetList([
      {
        TemplatePreset: {
          ID: "abc",
          Name: "Real World App",
          Default: true,
          Description: "desc",
          DesiredPrebuildInstances: 0,
        },
      },
      { TemplatePreset: { ID: "def", Name: "Minimal", Default: false, Description: "" } },
    ]);
    expect(presets).toEqual([
      { name: "Real World App", default: true, description: "desc" },
      { name: "Minimal", default: false },
    ]);
  });

  it("also accepts a flat snake_case shape", () => {
    const presets = parsePresetList([{ name: "Standard", default: true }]);
    expect(presets).toEqual([{ name: "Standard", default: true }]);
  });

  it("returns [] for non-array input", () => {
    expect(parsePresetList(null)).toEqual([]);
  });
});

describe("parsePresetsOutput", () => {
  it('treats the "No presets found" CLI message as no presets', () => {
    expect(
      parsePresetsOutput('No presets found for template "docker" and template-version "x".\r\n'),
    ).toEqual([]);
  });

  it("treats empty output as no presets", () => {
    expect(parsePresetsOutput("   \n")).toEqual([]);
  });

  it("parses the wrapped JSON array", () => {
    const out = parsePresetsOutput('[{"TemplatePreset":{"Name":"Standard","Default":true}}]');
    expect(out).toEqual([{ name: "Standard", default: true }]);
  });

  it("throws on genuinely malformed JSON", () => {
    expect(() => parsePresetsOutput("{not json")).toThrow();
  });
});
