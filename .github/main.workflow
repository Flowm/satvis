workflow "NPM" {
  on = "push"
  resolves = [
    "NPM lint",
    "NPM build",
  ]
}

action "NPM install" {
  uses = "actions/npm@6309cd9"
  args = "install"
}

action "NPM lint" {
  uses = "actions/npm@6309cd9"
  needs = ["NPM install"]
  args = "run lint"
}

action "NPM build" {
  uses = "actions/npm@6309cd9"
  needs = ["NPM install"]
  args = "run build"
}
