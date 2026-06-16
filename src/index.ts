export {
  buildCreateArgs,
  buildLocalForwardArgs,
  buildSshArgs,
  CoderCliTransport,
  type CoderCliTransportOptions,
  parsePresetList,
  parsePresetsOutput,
  parseWorkspaceRef,
  parseWorkspaceStatus,
} from './cli-transport.js';
export {
  CODER_WORKSPACE_PROVIDER_ID,
  type CoderCreateSettings,
  type CoderWorkspaceBaseSettings,
  type CoderWorkspaceRef,
  type CoderWorkspaceSettings,
  createCoderWorkspace,
} from './coder-workspace-provider.js';
export {
  CoderWorkspaceSession,
  type CoderWorkspaceSessionConfig,
} from './coder-workspace-session.js';
export { buildRemoteScript, type RemoteCommandOptions, shellQuote } from './shell.js';
export type {
  CoderTransport,
  CreateWorkspaceOptions,
  ExecResult,
  ForwardPortOptions,
  LifecycleOptions,
  ListPresetsOptions,
  PortForward,
  PresetInfo,
  SpawnedProcess,
  TransportExecOptions,
  WorkspaceAgentInfo,
  WorkspaceAgentLifecycle,
  WorkspaceAgentStatus,
  WorkspaceBuildStatus,
  WorkspaceStatus,
} from './transport.js';
