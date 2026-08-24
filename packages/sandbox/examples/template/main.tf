# Coder template for @coder/ai-sdk-sandbox workspaces. A trimmed-down variant
# of Coder's example Docker template
# (https://github.com/coder/coder/tree/main/examples/templates/docker) — only
# the ai-sdk-sandbox-specific parts differ; see the inline comments.
terraform {
  required_providers {
    coder = {
      source = "coder/coder"
    }
    docker = {
      source = "kreuzwerker/docker"
    }
  }
}

variable "docker_socket" {
  default     = ""
  description = "(Optional) Docker socket URI"
  type        = string
}

variable "image" {
  # Build from the Dockerfile next to this file, then push the image to a
  # registry your Coder provisioners can pull from.
  default     = "ai-sdk-sandbox-workspace:latest"
  description = "Workspace image with the pre-baked harness bootstrap"
  type        = string
}

provider "docker" {
  host = var.docker_socket != "" ? var.docker_socket : null
}

data "coder_provisioner" "me" {}
data "coder_workspace" "me" {}
data "coder_workspace_owner" "me" {}

resource "coder_agent" "main" {
  arch = data.coder_provisioner.me.arch
  os   = "linux"

  # createCoderWorkspace's create mode (and ensureCoderWorkspace) wait for the
  # agent to reach `lifecycle_state: ready` before the harness runs. "blocking"
  # (default: "non-blocking") makes ready wait for the startup script, so
  # sessions can rely on everything it did.
  startup_script_behavior = "blocking"
  startup_script          = <<-EOT
    set -e
    # Prepare user home with default files on first start.
    if [ ! -f ~/.init_done ]; then
      cp -rT /etc/skel ~
      touch ~/.init_done
    fi
  EOT

  # Optional: provide the model API key workspace-side instead of passing it
  # from the host through the adapter's `auth` option:
  # env = {
  #   ANTHROPIC_API_KEY = var.anthropic_api_key
  # }
}

resource "docker_volume" "home_volume" {
  name = "coder-${data.coder_workspace.me.id}-home"
  # Protect the volume from being deleted due to changes in attributes.
  lifecycle {
    ignore_changes = all
  }
}

resource "docker_container" "workspace" {
  count = data.coder_workspace.me.start_count
  image = var.image
  # Uses lower() to avoid Docker restriction on container names.
  name     = "coder-${data.coder_workspace_owner.me.name}-${lower(data.coder_workspace.me.name)}"
  hostname = data.coder_workspace.me.name
  # Use the docker gateway if the access URL is 127.0.0.1.
  entrypoint = ["sh", "-c", replace(coder_agent.main.init_script, "/localhost|127\\.0\\.0\\.1/", "host.docker.internal")]
  env        = ["CODER_AGENT_TOKEN=${coder_agent.main.token}"]
  host {
    host = "host.docker.internal"
    ip   = "host-gateway"
  }
  # Docker populates a fresh (empty) named volume from the image's content at
  # the mount path, so the pre-baked /home/coder/.harness-bootstrap cache lands
  # in every new workspace's home volume. No bridge port configuration is
  # needed: the provider forwards the bridge port itself (SSH -L or the native
  # relay), not through template-level port shares.
  volumes {
    container_path = "/home/coder"
    volume_name    = docker_volume.home_volume.name
    read_only      = false
  }
}
