export {
  createCoderSandbox,
  CODER_SANDBOX_PROVIDER_ID,
  type CoderSandboxSettings,
  type CoderCreateSettings,
} from './coder-sandbox-provider.js';

export {
  CoderNetworkSandboxSession,
  type CoderNetworkSandboxSessionConfig,
} from './coder-network-sandbox-session.js';

export {
  CoderCliTransport,
  type CoderCliTransportOptions,
  buildSshArgs,
  buildLocalForwardArgs,
  buildCreateArgs,
  parseWorkspaceRef,
  parseWorkspaceStatus,
  parsePresetList,
  parsePresetsOutput,
} from './cli-transport.js';

export type {
  CoderTransport,
  TransportExecOptions,
  ExecResult,
  SpawnedProcess,
  PortForward,
  ForwardPortOptions,
  LifecycleOptions,
  WorkspaceStatus,
  WorkspaceBuildStatus,
  WorkspaceAgentInfo,
  WorkspaceAgentStatus,
  WorkspaceAgentLifecycle,
  CreateWorkspaceOptions,
  ListPresetsOptions,
  PresetInfo,
} from './transport.js';

export { shellQuote, buildRemoteScript, type RemoteCommandOptions } from './shell.js';
