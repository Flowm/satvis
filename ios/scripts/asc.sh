# Sourced by the scripts that read or change the App Store listing through asc,
# which takes the app from ASC_APP_ID; the Makefile exports it.
: "${ASC_APP_ID:?run this through make in ios/, which sets ASC_APP_ID}"

# The version states whose metadata can still be edited.
editable=PREPARE_FOR_SUBMISSION,DEVELOPER_REJECTED,REJECTED,METADATA_REJECTED,INVALID_BINARY

# Prints the message on stderr and exits.
fail() {
  echo "$*" >&2
  exit 1
}

# Prints the value at key path $2 of the JSON $1, or nothing if there is none.
# Not through echo: sh's echo turns the \n in a JSON string into a line break.
value() {
  printf %s "$1" | plutil -extract "$2" raw -o - - 2>/dev/null || true
}
