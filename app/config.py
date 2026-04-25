from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file_encoding="utf-8", extra="ignore")

    # TURN server (optional). Without it, STUN-only fallback works on most home networks
    # but fails for ~30% of guests behind symmetric NAT (corporate, mobile carriers).
    turn_server_url: str | None = None
    turn_server_username: str | None = None
    turn_server_credential: str | None = None

    # Where the guest SPA's static build lives, relative to repo root.
    # Production: dist baked into the Docker image. Dev: built by `pnpm -C guest build`.
    guest_dist_path: str = "guest/dist"

    log_level: str = "INFO"


settings = Settings()
