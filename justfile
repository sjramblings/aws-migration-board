set dotenv-load

# Launch the AWS Migration Board
migrate:
  cd .pi/migration-board && pi -e ../../extensions/migration-board.ts

# Default recipe
default:
  @just --list
