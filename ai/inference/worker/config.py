"""Worker configuration from environment variables."""

from __future__ import annotations

import socket
from functools import lru_cache
from typing import Literal

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=None, extra="ignore", case_sensitive=False, populate_by_name=True
    )

    redis_url: str = Field(default="redis://localhost:6379/0", alias="REDIS_URL")
    s3_endpoint: str = Field(default="http://localhost:8333", alias="S3_ENDPOINT")
    s3_access_key: str = Field(default="", alias="S3_ACCESS_KEY")
    s3_secret_key: str = Field(default="", alias="S3_SECRET_KEY")
    s3_region: str = Field(default="us-east-1", alias="S3_REGION")
    worker_role: Literal["ai", "ingest"] = Field(default="ai", alias="WORKER_ROLE")
    worker_kind: Literal["cpu", "gpu"] = Field(default="cpu", alias="WORKER_KIND")
    worker_id: str = Field(default_factory=socket.gethostname, alias="WORKER_ID")
    health_port: int = Field(default=8090, alias="HEALTH_PORT")
    log_level: str = Field(default="INFO", alias="LOG_LEVEL")
    seg_threads: int | None = Field(default=None, ge=1, alias="SEG_THREADS")
    seg_max_grid_voxels: int | None = Field(default=None, ge=1, alias="SEG_MAX_GRID_VOXELS")


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
