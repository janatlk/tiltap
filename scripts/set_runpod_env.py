#!/usr/bin/env python3
"""Set environment variables on a RunPod serverless template."""
import argparse
import os
import sys
from pathlib import Path

import requests

GRAPHQL_URL = "https://api.runpod.io/graphql"


def load_key(path_or_value: str | None) -> str:
    if not path_or_value:
        raise ValueError("RunPod personal API key is required")
    p = Path(path_or_value)
    if p.is_file():
        return p.read_text().strip()
    return path_or_value.strip()


def graphql(api_key: str, query: str, variables: dict | None = None) -> dict:
    resp = requests.post(
        GRAPHQL_URL,
        headers={"content-type": "application/json"},
        params={"api_key": api_key},
        json={"query": query, "variables": variables or {}},
        timeout=60,
    )
    resp.raise_for_status()
    data = resp.json()
    if data.get("errors"):
        raise RuntimeError(f"GraphQL error: {data['errors']}")
    return data["data"]


def get_endpoint(api_key: str, endpoint_id: str) -> dict:
    q = """
    query ($id: String!) {
      myself {
        endpoint(id: $id) {
          id
          templateId
          template {
            id
            imageName
            name
            containerDiskInGb
            volumeInGb
            volumeMountPath
            env { key value }
            dockerArgs
            ports
            isPublic
            isServerless
            readme
            runtimeInMin
          }
        }
      }
    }
    """
    return graphql(api_key, q, {"id": endpoint_id})["myself"]["endpoint"]


def save_template(api_key: str, template: dict) -> dict:
    q = """
    mutation ($input: SaveTemplateInput!) {
      saveTemplate(input: $input) { id imageName name }
    }
    """
    env = template.get("env") or []
    if isinstance(env, dict):
        env = [{"key": k, "value": v} for k, v in env.items()]
    variables = {
        "input": {
            "id": template["id"],
            "imageName": template["imageName"],
            "name": template["name"],
            "containerDiskInGb": template["containerDiskInGb"],
            "volumeInGb": template.get("volumeInGb", 0),
            "dockerArgs": template.get("dockerArgs") or "",
            "env": env,
            "ports": template.get("ports") or "",
        }
    }
    return graphql(api_key, q, variables)["saveTemplate"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--endpoint-id", required=True)
    parser.add_argument("--personal-api-key", default=".keys/runpod_personal_api_key")
    parser.add_argument("--set", action="append", default=[], help="KEY=VALUE (can repeat)")
    parser.add_argument("--unset", action="append", default=[], help="KEY to remove (can repeat)")
    args = parser.parse_args()

    api_key = load_key(args.personal_api_key)
    endpoint = get_endpoint(api_key, args.endpoint_id)
    template = endpoint["template"]

    env_map = {}
    for e in template.get("env") or []:
        env_map[e["key"]] = e["value"]

    for s in args.set:
        if "=" not in s:
            print(f"ERROR: --set must be KEY=VALUE: {s}", file=sys.stderr)
            return 1
        k, v = s.split("=", 1)
        env_map[k] = v
    for k in args.unset:
        env_map.pop(k, None)

    template["env"] = [{"key": k, "value": v} for k, v in env_map.items()]
    save_template(api_key, template)
    print(f"Template {template['id']} updated. Current env:")
    for e in template["env"]:
        print(f"  {e['key']}={e['value']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
