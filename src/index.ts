export {
  createCoderWorkspace,
  CODER_WORKSPACE_PROVIDER_ID,
  type CoderWorkspaceSettings,
  type CoderCreateSettings,
} from './coder-workspace-provider.js';

export {
  CoderWorkspaceSession,
  type CoderWorkspaceSessionConfig,
} from './coder-workspace-session.js';

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
