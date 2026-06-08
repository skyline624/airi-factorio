## Development

To get started, you need to create save file for Factorio:

```bash
/path/to/factorio --create /path/to/save.zip
```

Then you need to copy the `.env.example` file to `.env.local` and fill in the values.

Launch the `factorio-rcon-api-server`

## LLM provider

The agent talks to any OpenAI-compatible chat API through three env vars (see `.env.example`):

- `OPENAI_API_KEY` — API key (any non-empty placeholder works for most local servers).
- `OPENAI_API_BASEURL` — base URL; leave empty for OpenAI, or point it at a local server.
- `OPENAI_MODEL` — model id (default `gpt-4o`).

| Provider | `OPENAI_API_BASEURL` | `OPENAI_MODEL` |
| --- | --- | --- |
| OpenAI | *(empty)* | `gpt-4o` |
| Ollama | `http://localhost:11434/v1` | e.g. `qwen2.5` |
| LM Studio | `http://localhost:1234/v1` | *(loaded model)* |
| vLLM | `http://localhost:8000/v1` | *(served model)* |

> The agent uses function calling (tools) and expects a single JSON object as its reply. The chosen model **must** support tool calling and produce valid JSON — many small local models do not and will fail here.