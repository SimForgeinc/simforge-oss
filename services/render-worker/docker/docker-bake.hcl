variable "SOURCE_REVISION" {
  validation {
    condition = can(regex("^[0-9a-f]{40}$", SOURCE_REVISION))
    error_message = "SOURCE_REVISION must be the immutable 40-hex source commit SHA (it becomes the org.opencontainers.image.revision label launchers derive SIMFORGE_WORKER_REVISION from)"
  }
}

variable "IMAGE_VERSION" {
  validation {
    condition = IMAGE_VERSION != ""
    error_message = "IMAGE_VERSION must be set"
  }
}

group "default" {
  targets = ["browser-worker", "carla-worker", "native-worker"]
}

target "common" {
  context = "."
  contexts = {
    source = "../../.."
  }
  args = {
    SOURCE_REVISION = SOURCE_REVISION
    IMAGE_VERSION = IMAGE_VERSION
  }
  platforms = ["linux/amd64"]
}

target "browser-worker" {
  inherits = ["common"]
  dockerfile = "browser.Dockerfile"
  tags = ["simforge/browser-render-worker:${IMAGE_VERSION}"]
}

target "carla-worker" {
  inherits = ["common"]
  dockerfile = "carla.Dockerfile"
  tags = ["simforge/carla-render-worker:${IMAGE_VERSION}"]
}

target "native-worker" {
  inherits = ["common"]
  dockerfile = "native.Dockerfile"
  tags = ["simforge/native-render-worker:${IMAGE_VERSION}"]
}
