#!/usr/bin/env python3
"""Force a RunPod serverless endpoint to pull a new GPU STT image.

This script updates the bound template for the endpoint and terminates the
existing worker pods so the next requests spin up workers with the new image.

It needs a *personal* RunPod API key (Settings > API Keys). The endpoint-only
key used for /runsync is not sufficient for template/endpoint management.
"""

import argparse
import os
import re
import sys
import time
from pathlib import Path

import requests

GRAPHQL_URL = "https://api.runpod.io/graphql"
REST_URL = "https://rest.runpod.io/v1"
RUNTIME_URL = "https://api.runpod.ai/v2"


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
          name
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
          gpuIds
          workersMax
          workersMin
          workersStandby
          idleTimeout
          gpuCount
        }
      }
    }
    """
    return graphql(api_key, q, {"id": endpoint_id})["myself"]["endpoint"]


def save_template(api_key: str, template: dict, image_name: str) -> dict:
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
            "imageName": image_name,
            "name": template["name"],
            "containerDiskInGb": template["containerDiskInGb"],
            "volumeInGb": template.get("volumeInGb", 0),
            "dockerArgs": template.get("dockerArgs") or "",
            "env": env,
            "ports": template.get("ports") or "",
        }
    }
    return graphql(api_key, q, variables)["saveTemplate"]


def list_endpoint_pods(api_key: str, endpoint_id: str) -> list[dict]:
    q = """
    query ($id: String!) {
      myself {
        endpoint(id: $id) {
          pods { id name }
        }
      }
    }
    """
    return graphql(api_key, q, {"id": endpoint_id})["myself"]["endpoint"]["pods"]


def terminate_pod(api_key: str, pod_id: str) -> None:
    q = """
    mutation ($input: PodTerminateInput!) {
      podTerminate(input: $input)
    }
    """
    graphql(api_key, q, {"input": {"podId": pod_id}})


def get_health(endpoint_id: str, endpoint_api_key: str) -> dict:
    url = f"{RUNTIME_URL}/{endpoint_id}/health"
    resp = requests.get(
        url,
        headers={"Authorization": f"Bearer {endpoint_api_key}"},
        timeout=30,
    )
    resp.raise_for_status()
    return resp.json()


def extract_endpoint_id(url: str) -> str:
    m = re.search(r"/v2/([a-z0-9]+)/", url)
    if m:
        return m.group(1)
    m = re.search(r"([a-z0-9]{10,})", url)
    if m:
        return m.group(1)
    raise ValueError(f"Cannot extract endpoint id from {url}")


def wait_for_ready_workers(
    endpoint_id: str,
    endpoint_api_key: str,
    timeout: int = 300,
    min_ready: int = 1,
) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        health = get_health(endpoint_id, endpoint_api_key)
        workers = health.get("workers", {})
        print(
            f"  workers: idle={workers.get('idle', 0)} "
            f"initializing={workers.get('initializing', 0)} "
            f"ready={workers.get('ready', 0)} "
            f"running={workers.get('running', 0)} "
            f"unhealthy={workers.get('unhealthy', 0)}"
        )
        if workers.get("ready", 0) >= min_ready and workers.get("running", 0) == 0:
            return health
        time.sleep(10)
    raise TimeoutError("Timed out waiting for workers to become ready")


def main() -> int:
    parser = argparse.ArgumentParser(description="Force RunPod GPU STT endpoint to pull a new image")
    parser.add_argument("--endpoint-id", help="RunPod endpoint id (or TILTAB_GPU_STT_ENDPOINT_ID)")
    parser.add_argument("--endpoint-url", help="RunPod endpoint URL (e.g. https://api.runpod.ai/v2/xxx/runsync)")
    parser.add_argument("--personal-api-key", help="Path to personal API key file or the key itself")
    parser.add_argument("--endpoint-api-key", help="Endpoint API key for health checks")
    parser.add_argument("--image", default="janatlk/tiltap-gpu-stt:latest", help="New container image reference")
    parser.add_argument("--wait", action="store_true", help="Wait until at least one worker is ready")
    parser.add_argument("--wait-timeout", type=int, default=300, help="Seconds to wait for ready workers")
    args = parser.parse_args()

    endpoint_id = args.endpoint_id or os.environ.get("TILTAB_GPU_STT_ENDPOINT_ID")
    if not endpoint_id and args.endpoint_url:
        endpoint_id = extract_endpoint_id(args.endpoint_url)
    if not endpoint_id:
        env_url = os.environ.get("TILTAB_GPU_STT_URL", "")
        if env_url:
            endpoint_id = extract_endpoint_id(env_url)
    if not endpoint_id:
        print("ERROR: --endpoint-id, --endpoint-url, or TILTAB_GPU_STT_URL/ENDPOINT_ID required", file=sys.stderr)
        return 1

    personal_key_path = args.personal_api_key or os.environ.get("RUNPOD_PERSONAL_API_KEY", ".keys/runpod_personal_api_key")
    try:
        personal_api_key = load_key(personal_key_path)
    except Exception as e:
        print(f"ERROR: cannot load personal API key: {e}", file=sys.stderr)
        return 1

    endpoint_api_key = args.endpoint_api_key or os.environ.get("TILTAB_GPU_STT_API_KEY", "")

    print(f"Endpoint: {endpoint_id}")
    print(f"New image: {args.image}")

    print("\n1. Fetching current endpoint/template...")
    endpoint = get_endpoint(personal_api_key, endpoint_id)
    template = endpoint["template"]
    print(f"   Current template image: {template['imageName']}")

    print("\n2. Saving template with new image...")
    save_template(personal_api_key, template, args.image)
    print("   Template updated.")

    print("\n3. Terminating existing worker pods...")
    pods = list_endpoint_pods(personal_api_key, endpoint_id)
    if not pods:
        print("   No running pods found.")
    for pod in pods:
        print(f"   - {pod['id']}")
        terminate_pod(personal_api_key, pod["id"])
    print(f"   Terminated {len(pods)} pod(s).")

    if args.wait and endpoint_api_key:
        print("\n4. Waiting for new workers to become ready...")
        try:
            wait_for_ready_workers(endpoint_id, endpoint_api_key, timeout=args.wait_timeout)
            print("   Workers are ready.")
        except TimeoutError as e:
            print(f"   WARNING: {e}", file=sys.stderr)
            return 2

    print("\nDone. The endpoint will now pull the new image on the next worker start.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
