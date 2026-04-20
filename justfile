set dotenv-load

# Launch the AWS Migration Board (SA on gpt-5.4, board members on gpt-5.4-mini via frontmatter)
migrate:
  cd .pi/migration-board && pi --model openai-codex/gpt-5.4 -e ../../extensions/migration-board.ts

# Default recipe
default:
  @just --list
