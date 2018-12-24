workflow "Main workflow" {
  on = "push"
  resolves = [
    "NPM lint",
    "NPM build",
  ]
}

action "NPM install" {
  uses = "actions/npm@master"
  args = "install"
}

action "NPM lint" {
  uses = "actions/npm@master"
  needs = ["NPM install"]
  args = "run lint"
}

action "NPM build" {
  uses = "actions/npm@master"
  needs = ["NPM install"]
  args = "run build"
}
