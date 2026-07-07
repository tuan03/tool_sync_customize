#!/usr/bin/env python3
"""
shopify_codex_tool.py

A safe, MCP-like CLI helper for Codex/AI agents during Shopify theme development.

What this tool does:
- Reads .env.shopify for Shopify app/store credentials.
- Helps obtain Admin API access tokens via Shopify OAuth flows.
- Calls Shopify Admin GraphQL API.
- Exports product/content/custom-data context for theme development.
- Provides dry-run by default for write operations.
- Exposes a machine-readable `mcp-tools` manifest so Codex can understand commands.

This is not a full MCP JSON-RPC server. It is an MCP-like command-line adapter.
You can wrap these commands in a real MCP stdio server later if needed.
"""

from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import mimetypes
import os
import secrets
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

DEFAULT_ENV_FILE = ".env.shopify"
DEFAULT_API_VERSION = "2026-04"
DEFAULT_SCOPES = ",".join([
    "read_products",
    "write_products",
    "read_files",
    "write_files",
    "read_metaobjects",
    "write_metaobjects",
    "read_metaobject_definitions",
    "write_metaobject_definitions",
    "read_themes",
    "write_themes",
    "read_content",
    "write_content",
])


class ToolError(Exception):
    pass


def eprint(*args: Any) -> None:
    print(*args, file=sys.stderr)


def read_env_file(path: str | Path) -> Dict[str, str]:
    env: Dict[str, str] = {}
    p = Path(path)
    if not p.exists():
        return env
    for raw_line in p.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        env[key] = value
    return env


def write_env_value(path: str | Path, key: str, value: str) -> None:
    p = Path(path)
    lines: List[str] = []
    found = False
    if p.exists():
        lines = p.read_text(encoding="utf-8").splitlines()
    next_lines: List[str] = []
    for line in lines:
        if line.strip().startswith(f"{key}="):
            next_lines.append(f'{key}="{value}"')
            found = True
        else:
            next_lines.append(line)
    if not found:
        if next_lines and next_lines[-1].strip():
            next_lines.append("")
        next_lines.append(f'{key}="{value}"')
    p.write_text("\n".join(next_lines) + "\n", encoding="utf-8")


def load_config(args: argparse.Namespace) -> Dict[str, str]:
    env_file = getattr(args, "env_file", None) or os.environ.get("SHOPIFY_ENV_FILE", DEFAULT_ENV_FILE)
    file_env = read_env_file(env_file)
    cfg = {**file_env, **{k: v for k, v in os.environ.items() if k.startswith("SHOPIFY_")}}
    cfg["SHOPIFY_ENV_FILE"] = str(env_file)
    cfg.setdefault("SHOPIFY_API_VERSION", DEFAULT_API_VERSION)
    cfg.setdefault("SHOPIFY_SCOPES", DEFAULT_SCOPES)
    return cfg


def normalize_shop(shop: str) -> str:
    shop = shop.strip().replace("https://", "").replace("http://", "").strip("/")
    if not shop:
        raise ToolError("Missing SHOPIFY_SHOP. Example: my-dev-store.myshopify.com")
    if "." not in shop:
        shop = f"{shop}.myshopify.com"
    if not shop.endswith(".myshopify.com"):
        raise ToolError("SHOPIFY_SHOP must be a *.myshopify.com domain for Admin API OAuth/API calls.")
    return shop


def require_cfg(cfg: Dict[str, str], keys: Iterable[str]) -> None:
    missing = [k for k in keys if not cfg.get(k)]
    if missing:
        raise ToolError(f"Missing config keys: {', '.join(missing)}. Create/update .env.shopify.")


def print_json(data: Any) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2))


def read_json_file(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_text_file(path: str | Path) -> str:
    return Path(path).read_text(encoding="utf-8")


def http_json(method: str, url: str, payload: Optional[Dict[str, Any]] = None, headers: Optional[Dict[str, str]] = None) -> Dict[str, Any]:
    body: Optional[bytes] = None
    req_headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if headers:
        req_headers.update(headers)
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=req_headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            if not raw:
                return {}
            return json.loads(raw)
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        raise ToolError(f"HTTP {exc.code} {exc.reason}: {raw}") from exc
    except urllib.error.URLError as exc:
        raise ToolError(f"Network error: {exc}") from exc


def admin_graphql(cfg: Dict[str, str], query: str, variables: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    require_cfg(cfg, ["SHOPIFY_SHOP", "SHOPIFY_ACCESS_TOKEN"])
    shop = normalize_shop(cfg["SHOPIFY_SHOP"])
    version = cfg.get("SHOPIFY_API_VERSION", DEFAULT_API_VERSION)
    url = f"https://{shop}/admin/api/{version}/graphql.json"
    data = http_json(
        "POST",
        url,
        {"query": query, "variables": variables or {}},
        headers={"X-Shopify-Access-Token": cfg["SHOPIFY_ACCESS_TOKEN"]},
    )
    # Shopify GraphQL can return partial data + errors.
    if "errors" in data:
        return {"ok": False, "errors": data.get("errors"), "data": data.get("data")}
    return {"ok": True, "data": data.get("data"), "extensions": data.get("extensions")}


def dry_run_or_apply(args: argparse.Namespace, label: str, payload: Dict[str, Any]) -> bool:
    if getattr(args, "apply", False):
        return True
    print_json({"dryRun": True, "operation": label, "payload": payload, "hint": "Add --apply to execute."})
    return False


# ----------------------------- Auth commands -----------------------------

def cmd_env_example(args: argparse.Namespace) -> None:
    example = f'''# Required
SHOPIFY_SHOP="your-dev-store.myshopify.com"
SHOPIFY_CLIENT_ID="your_client_id"
SHOPIFY_CLIENT_SECRET="your_client_secret"

# Optional but recommended
SHOPIFY_API_VERSION="{DEFAULT_API_VERSION}"
SHOPIFY_SCOPES="{DEFAULT_SCOPES}"
SHOPIFY_REDIRECT_URI="http://127.0.0.1:3456/callback"

# Filled by token commands when using --save
# SHOPIFY_ACCESS_TOKEN="shpat_or_token_value"
'''
    print(example)


def cmd_auth_url(args: argparse.Namespace) -> None:
    cfg = load_config(args)
    require_cfg(cfg, ["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID"])
    shop = normalize_shop(cfg["SHOPIFY_SHOP"])
    redirect_uri = args.redirect_uri or cfg.get("SHOPIFY_REDIRECT_URI")
    if not redirect_uri:
        raise ToolError("Missing redirect URI. Pass --redirect-uri or set SHOPIFY_REDIRECT_URI.")
    scopes = args.scopes or cfg.get("SHOPIFY_SCOPES", DEFAULT_SCOPES)
    state = args.state or secrets.token_urlsafe(24)
    params = urllib.parse.urlencode({
        "client_id": cfg["SHOPIFY_CLIENT_ID"],
        "scope": scopes,
        "redirect_uri": redirect_uri,
        "state": state,
    })
    url = f"https://{shop}/admin/oauth/authorize?{params}"
    print_json({
        "installUrl": url,
        "state": state,
        "nextStep": "Open installUrl, approve app, then run: python shopify_codex_tool.py exchange-code --code <code-from-callback> --save",
    })


def cmd_token_client_credentials(args: argparse.Namespace) -> None:
    cfg = load_config(args)
    require_cfg(cfg, ["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"])
    shop = normalize_shop(cfg["SHOPIFY_SHOP"])
    url = f"https://{shop}/admin/oauth/access_token"
    payload = {
        "client_id": cfg["SHOPIFY_CLIENT_ID"],
        "client_secret": cfg["SHOPIFY_CLIENT_SECRET"],
        "grant_type": "client_credentials",
    }
    data = http_json("POST", url, payload)
    token = data.get("access_token")
    if args.save and token:
        write_env_value(cfg["SHOPIFY_ENV_FILE"], "SHOPIFY_ACCESS_TOKEN", token)
    print_json({
        "saved": bool(args.save and token),
        "tokenReceived": bool(token),
        "response": data if args.show_token else {k: ("***" if "token" in k.lower() else v) for k, v in data.items()},
    })


def cmd_exchange_code(args: argparse.Namespace) -> None:
    cfg = load_config(args)
    require_cfg(cfg, ["SHOPIFY_SHOP", "SHOPIFY_CLIENT_ID", "SHOPIFY_CLIENT_SECRET"])
    shop = normalize_shop(args.shop or cfg["SHOPIFY_SHOP"])
    url = f"https://{shop}/admin/oauth/access_token"
    payload = {
        "client_id": cfg["SHOPIFY_CLIENT_ID"],
        "client_secret": cfg["SHOPIFY_CLIENT_SECRET"],
        "code": args.code,
    }
    data = http_json("POST", url, payload)
    token = data.get("access_token")
    if args.save and token:
        write_env_value(cfg["SHOPIFY_ENV_FILE"], "SHOPIFY_ACCESS_TOKEN", token)
    print_json({
        "saved": bool(args.save and token),
        "tokenReceived": bool(token),
        "scope": data.get("scope"),
        "response": data if args.show_token else {k: ("***" if "token" in k.lower() else v) for k, v in data.items()},
    })


def cmd_verify_hmac(args: argparse.Namespace) -> None:
    cfg = load_config(args)
    require_cfg(cfg, ["SHOPIFY_CLIENT_SECRET"])
    query = args.query_string.lstrip("?")
    parsed = urllib.parse.parse_qsl(query, keep_blank_values=True)
    given_hmac = None
    pairs: List[Tuple[str, str]] = []
    for k, v in parsed:
        if k == "hmac":
            given_hmac = v
        elif k != "signature":
            pairs.append((k, v))
    msg = "&".join(f"{k}={v}" for k, v in sorted(pairs)).encode("utf-8")
    digest = hmac.new(cfg["SHOPIFY_CLIENT_SECRET"].encode("utf-8"), msg, hashlib.sha256).hexdigest()
    print_json({"valid": hmac.compare_digest(given_hmac or "", digest), "computedHmac": digest})


# ----------------------------- Query commands -----------------------------

SHOP_INFO_QUERY = """
query ShopInfo {
  shop {
    id
    name
    myshopifyDomain
    primaryDomain { url host }
    currencyCode
    email
  }
}
"""

PRODUCTS_QUERY = """
query Products($first: Int!, $query: String) {
  products(first: $first, query: $query) {
    edges {
      cursor
      node {
        id
        title
        handle
        status
        vendor
        productType
        tags
        descriptionHtml
        createdAt
        updatedAt
        options { id name values }
        featuredMedia { ... on MediaImage { image { url altText } } }
        variants(first: 50) {
          edges { node { id title sku price selectedOptions { name value } } }
        }
        metafields(first: 50) {
          edges { node { id namespace key type value } }
        }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""

PRODUCT_BY_HANDLE_QUERY = """
query ProductByHandle($handle: String!) {
  productByHandle(handle: $handle) {
    id
    title
    handle
    status
    vendor
    productType
    tags
    descriptionHtml
    createdAt
    updatedAt
    seo { title description }
    options { id name values }
    featuredMedia { ... on MediaImage { image { url altText } } }
    media(first: 50) {
      edges { node { id mediaContentType alt status ... on MediaImage { image { url width height altText } } } }
    }
    variants(first: 100) {
      edges { node { id title sku price compareAtPrice selectedOptions { name value } } }
    }
    metafields(first: 100) {
      edges { node { id namespace key type value createdAt updatedAt } }
    }
  }
}
"""

COLLECTIONS_QUERY = """
query Collections($first: Int!, $query: String) {
  collections(first: $first, query: $query) {
    edges {
      cursor
      node {
        id
        title
        handle
        descriptionHtml
        updatedAt
        image { url altText }
        metafields(first: 30) { edges { node { namespace key type value } } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""

METAFIELD_DEFINITIONS_QUERY = """
query MetafieldDefinitions($ownerType: MetafieldOwnerType!, $first: Int!) {
  metafieldDefinitions(ownerType: $ownerType, first: $first) {
    edges {
      node {
        id
        name
        namespace
        key
        ownerType
        description
        type { name category }
        validations { name value }
      }
    }
  }
}
"""

METAOBJECT_DEFINITIONS_QUERY = """
query MetaobjectDefinitions($first: Int!) {
  metaobjectDefinitions(first: $first) {
    edges {
      node {
        id
        name
        type
        fieldDefinitions { key name required type { name category } validations { name value } }
        access { admin storefront }
        capabilities { publishable { enabled } translatable { enabled } }
      }
    }
  }
}
"""

METAOBJECTS_QUERY = """
query Metaobjects($type: String!, $first: Int!) {
  metaobjects(type: $type, first: $first) {
    edges {
      node {
        id
        handle
        type
        updatedAt
        fields { key value type }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""

FILES_QUERY = """
query Files($first: Int!, $query: String) {
  files(first: $first, query: $query) {
    edges {
      cursor
      node {
        id
        alt
        createdAt
        fileStatus
        ... on MediaImage { image { url width height altText } }
        ... on GenericFile { url mimeType fileSize }
        ... on Video { sources { url mimeType format height width } }
      }
    }
    pageInfo { hasNextPage endCursor }
  }
}
"""

THEMES_QUERY = """
query Themes($first: Int!) {
  themes(first: $first) {
    edges { node { id name role createdAt updatedAt processing processingFailed } }
  }
}
"""

THEME_FILE_GET_QUERY = """
query ThemeFileGet($id: ID!, $filenames: [String!]) {
  theme(id: $id) {
    id
    name
    role
    files(first: 50, filenames: $filenames) {
      nodes {
        filename
        size
        body { ... on OnlineStoreThemeFileBodyText { content } }
      }
    }
  }
}
"""

PAGES_QUERY = """
query Pages($first: Int!, $query: String) {
  pages(first: $first, query: $query) {
    edges { node { id title handle bodySummary createdAt updatedAt } }
    pageInfo { hasNextPage endCursor }
  }
}
"""

MENUS_QUERY = """
query Menus($first: Int!) {
  menus(first: $first) {
    edges {
      node {
        id
        handle
        title
        items { id title type url items { id title type url } }
      }
    }
  }
}
"""


def cmd_shop_info(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), SHOP_INFO_QUERY))


def cmd_graphql(args: argparse.Namespace) -> None:
    cfg = load_config(args)
    query = read_text_file(args.query_file) if args.query_file else args.query
    if not query:
        query = sys.stdin.read()
    variables = read_json_file(args.variables_file) if args.variables_file else {}
    if args.variables:
        variables.update(json.loads(args.variables))
    print_json(admin_graphql(cfg, query, variables))


def cmd_products_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), PRODUCTS_QUERY, {"first": args.first, "query": args.query}))


def cmd_product_get(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), PRODUCT_BY_HANDLE_QUERY, {"handle": args.handle}))


def cmd_collections_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), COLLECTIONS_QUERY, {"first": args.first, "query": args.query}))


def cmd_metafield_definitions_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), METAFIELD_DEFINITIONS_QUERY, {"ownerType": args.owner_type, "first": args.first}))


def cmd_metaobject_definitions_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), METAOBJECT_DEFINITIONS_QUERY, {"first": args.first}))


def cmd_metaobjects_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), METAOBJECTS_QUERY, {"type": args.type, "first": args.first}))


def cmd_files_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), FILES_QUERY, {"first": args.first, "query": args.query}))


def cmd_themes_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), THEMES_QUERY, {"first": args.first}))


def cmd_theme_file_get(args: argparse.Namespace) -> None:
    filenames = args.filename or ["*"]
    print_json(admin_graphql(load_config(args), THEME_FILE_GET_QUERY, {"id": args.theme_id, "filenames": filenames}))


def cmd_pages_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), PAGES_QUERY, {"first": args.first, "query": args.query}))


def cmd_menus_list(args: argparse.Namespace) -> None:
    print_json(admin_graphql(load_config(args), MENUS_QUERY, {"first": args.first}))


def cmd_scan_context(args: argparse.Namespace) -> None:
    cfg = load_config(args)
    result: Dict[str, Any] = {"generatedAt": int(time.time()), "apiVersion": cfg.get("SHOPIFY_API_VERSION", DEFAULT_API_VERSION)}
    tasks = [
        ("shop", SHOP_INFO_QUERY, {}),
        ("products", PRODUCTS_QUERY, {"first": args.first, "query": args.product_query}),
        ("collections", COLLECTIONS_QUERY, {"first": args.first, "query": args.collection_query}),
        ("productMetafieldDefinitions", METAFIELD_DEFINITIONS_QUERY, {"ownerType": "PRODUCT", "first": 100}),
        ("collectionMetafieldDefinitions", METAFIELD_DEFINITIONS_QUERY, {"ownerType": "COLLECTION", "first": 100}),
        ("metaobjectDefinitions", METAOBJECT_DEFINITIONS_QUERY, {"first": 100}),
        ("files", FILES_QUERY, {"first": args.first, "query": args.file_query}),
        ("themes", THEMES_QUERY, {"first": 50}),
    ]
    if args.include_content:
        tasks += [
            ("pages", PAGES_QUERY, {"first": args.first, "query": None}),
            ("menus", MENUS_QUERY, {"first": 50}),
        ]
    for key, query, variables in tasks:
        try:
            result[key] = admin_graphql(cfg, query, variables)
        except Exception as exc:  # keep scanning even if a scope is missing
            result[key] = {"ok": False, "error": str(exc)}
    if args.out:
        Path(args.out).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print_json({"ok": True, "out": args.out})
    else:
        print_json(result)


# ----------------------------- Mutation commands -----------------------------

PRODUCT_CREATE_MUTATION = """
mutation ProductCreate($product: ProductCreateInput!, $media: [CreateMediaInput!]) {
  productCreate(product: $product, media: $media) {
    product { id title handle status variants(first: 1) { edges { node { id title sku price } } } }
    userErrors { field message }
  }
}
"""

PRODUCT_UPDATE_MUTATION = """
mutation ProductUpdate($product: ProductUpdateInput!, $media: [CreateMediaInput!]) {
  productUpdate(product: $product, media: $media) {
    product { id title handle status updatedAt }
    userErrors { field message }
  }
}
"""

METAFIELD_DEFINITION_CREATE_MUTATION = """
mutation MetafieldDefinitionCreate($definition: MetafieldDefinitionInput!) {
  metafieldDefinitionCreate(definition: $definition) {
    createdDefinition { id name namespace key ownerType type { name } }
    userErrors { field message code }
  }
}
"""

METAFIELDS_SET_MUTATION = """
mutation MetafieldsSet($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    metafields { id namespace key type value updatedAt }
    userErrors { field message code }
  }
}
"""

METAOBJECT_DEFINITION_CREATE_MUTATION = """
mutation MetaobjectDefinitionCreate($definition: MetaobjectDefinitionCreateInput!) {
  metaobjectDefinitionCreate(definition: $definition) {
    metaobjectDefinition { id name type fieldDefinitions { key name } }
    userErrors { field message code }
  }
}
"""

METAOBJECT_CREATE_MUTATION = """
mutation MetaobjectCreate($metaobject: MetaobjectCreateInput!) {
  metaobjectCreate(metaobject: $metaobject) {
    metaobject { id handle type fields { key value } }
    userErrors { field message code }
  }
}
"""

FILE_CREATE_MUTATION = """
mutation FileCreate($files: [FileCreateInput!]!) {
  fileCreate(files: $files) {
    files {
      id
      alt
      fileStatus
      createdAt
      ... on MediaImage { image { url width height altText } }
      ... on GenericFile { url mimeType fileSize }
    }
    userErrors { field message code }
  }
}
"""

STAGED_UPLOADS_CREATE_MUTATION = """
mutation StagedUploadsCreate($input: [StagedUploadInput!]!) {
  stagedUploadsCreate(input: $input) {
    stagedTargets {
      url
      resourceUrl
      parameters { name value }
    }
    userErrors { field message }
  }
}
"""

THEME_CREATE_MUTATION = """
mutation ThemeCreate($name: String, $source: URL!, $role: ThemeRole) {
  themeCreate(name: $name, source: $source, role: $role) {
    theme { id name role processing processingFailed }
    userErrors { code field message }
  }
}
"""

THEME_PUBLISH_MUTATION = """
mutation ThemePublish($id: ID!) {
  themePublish(id: $id) {
    theme { id name role }
    userErrors { code field message }
  }
}
"""

THEME_FILES_UPSERT_MUTATION = """
mutation ThemeFilesUpsert($themeId: ID!, $files: [OnlineStoreThemeFilesUpsertFileInput!]!) {
  themeFilesUpsert(themeId: $themeId, files: $files) {
    job { id done }
    upsertedThemeFiles { filename }
    userErrors { field message }
  }
}
"""

THEME_FILES_DELETE_MUTATION = """
mutation ThemeFilesDelete($themeId: ID!, $files: [String!]!) {
  themeFilesDelete(themeId: $themeId, files: $files) {
    deletedThemeFiles { filename }
    userErrors { field message }
  }
}
"""


def cmd_product_create(args: argparse.Namespace) -> None:
    payload = read_json_file(args.json_file)
    product = payload.get("product", payload)
    media = payload.get("media")
    if not dry_run_or_apply(args, "productCreate", {"product": product, "media": media}):
        return
    print_json(admin_graphql(load_config(args), PRODUCT_CREATE_MUTATION, {"product": product, "media": media}))


def cmd_product_update(args: argparse.Namespace) -> None:
    payload = read_json_file(args.json_file)
    product = payload.get("product", payload)
    media = payload.get("media")
    if not dry_run_or_apply(args, "productUpdate", {"product": product, "media": media}):
        return
    print_json(admin_graphql(load_config(args), PRODUCT_UPDATE_MUTATION, {"product": product, "media": media}))


def cmd_metafield_definition_create(args: argparse.Namespace) -> None:
    definition = read_json_file(args.json_file).get("definition", read_json_file(args.json_file))
    if not dry_run_or_apply(args, "metafieldDefinitionCreate", {"definition": definition}):
        return
    print_json(admin_graphql(load_config(args), METAFIELD_DEFINITION_CREATE_MUTATION, {"definition": definition}))


def cmd_metafields_set(args: argparse.Namespace) -> None:
    payload = read_json_file(args.json_file)
    metafields = payload.get("metafields", payload)
    if not isinstance(metafields, list):
        raise ToolError("metafields JSON must be an array or {\"metafields\": [...]}.")
    if not dry_run_or_apply(args, "metafieldsSet", {"metafields": metafields}):
        return
    print_json(admin_graphql(load_config(args), METAFIELDS_SET_MUTATION, {"metafields": metafields}))


def cmd_metaobject_definition_create(args: argparse.Namespace) -> None:
    definition = read_json_file(args.json_file).get("definition", read_json_file(args.json_file))
    if not dry_run_or_apply(args, "metaobjectDefinitionCreate", {"definition": definition}):
        return
    print_json(admin_graphql(load_config(args), METAOBJECT_DEFINITION_CREATE_MUTATION, {"definition": definition}))


def cmd_metaobject_create(args: argparse.Namespace) -> None:
    metaobject = read_json_file(args.json_file).get("metaobject", read_json_file(args.json_file))
    if not dry_run_or_apply(args, "metaobjectCreate", {"metaobject": metaobject}):
        return
    print_json(admin_graphql(load_config(args), METAOBJECT_CREATE_MUTATION, {"metaobject": metaobject}))


def cmd_file_create_url(args: argparse.Namespace) -> None:
    file_input = {
        "originalSource": args.url,
        "contentType": args.content_type,
    }
    if args.alt:
        file_input["alt"] = args.alt
    if args.filename:
        file_input["filename"] = args.filename
    if not dry_run_or_apply(args, "fileCreate", {"files": [file_input]}):
        return
    print_json(admin_graphql(load_config(args), FILE_CREATE_MUTATION, {"files": [file_input]}))


def cmd_staged_upload_target(args: argparse.Namespace) -> None:
    input_item: Dict[str, Any] = {
        "resource": args.resource,
        "filename": args.filename,
        "mimeType": args.mime_type or mimetypes.guess_type(args.filename)[0] or "application/octet-stream",
        "httpMethod": args.http_method,
    }
    if args.file_size is not None:
        input_item["fileSize"] = str(args.file_size)
    print_json(admin_graphql(load_config(args), STAGED_UPLOADS_CREATE_MUTATION, {"input": [input_item]}))


def make_multipart_form(fields: Dict[str, str], file_field: Optional[Tuple[str, str, bytes, str]] = None) -> Tuple[bytes, str]:
    boundary = "----shopify-codex-" + secrets.token_hex(16)
    chunks: List[bytes] = []
    for name, value in fields.items():
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        chunks.append(str(value).encode())
        chunks.append(b"\r\n")
    if file_field:
        field_name, filename, content, content_type = file_field
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode())
        chunks.append(f"Content-Type: {content_type}\r\n\r\n".encode())
        chunks.append(content)
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), boundary


def cmd_staged_upload_file(args: argparse.Namespace) -> None:
    target = read_json_file(args.target_json)
    # Accept full GraphQL response or a target object.
    if "data" in target:
        target = target["data"]["stagedUploadsCreate"]["stagedTargets"][0]
    elif "stagedTargets" in target:
        target = target["stagedTargets"][0]
    url = target["url"]
    params = {p["name"]: p["value"] for p in target.get("parameters", [])}
    path = Path(args.path)
    content = path.read_bytes()
    content_type = args.mime_type or mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    body, boundary = make_multipart_form(params, (args.file_field, path.name, content, content_type))
    req = urllib.request.Request(url, data=body, headers={"Content-Type": f"multipart/form-data; boundary={boundary}"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = {"ok": True, "status": resp.status, "resourceUrl": target.get("resourceUrl"), "response": resp.read().decode("utf-8", errors="replace")}
    except urllib.error.HTTPError as exc:
        result = {"ok": False, "status": exc.code, "error": exc.read().decode("utf-8", errors="replace")}
    print_json(result)


def cmd_theme_create(args: argparse.Namespace) -> None:
    role = args.role if args.role != "UNPUBLISHED" else None
    payload = {"name": args.name, "source": args.source, "role": role}
    if not dry_run_or_apply(args, "themeCreate", payload):
        return
    print_json(admin_graphql(load_config(args), THEME_CREATE_MUTATION, payload))


def cmd_theme_publish(args: argparse.Namespace) -> None:
    payload = {"id": args.theme_id}
    if not dry_run_or_apply(args, "themePublish", payload):
        return
    print_json(admin_graphql(load_config(args), THEME_PUBLISH_MUTATION, payload))


def cmd_theme_files_upsert(args: argparse.Namespace) -> None:
    files: List[Dict[str, Any]] = []
    for item in args.file:
        filename, local_path = item.split("=", 1)
        value = Path(local_path).read_text(encoding="utf-8")
        files.append({"filename": filename, "body": {"type": "TEXT", "value": value}})
    payload = {"themeId": args.theme_id, "files": files}
    if not dry_run_or_apply(args, "themeFilesUpsert", payload):
        return
    print_json(admin_graphql(load_config(args), THEME_FILES_UPSERT_MUTATION, payload))


def cmd_theme_files_delete(args: argparse.Namespace) -> None:
    payload = {"themeId": args.theme_id, "files": args.filename}
    if not dry_run_or_apply(args, "themeFilesDelete", payload):
        return
    print_json(admin_graphql(load_config(args), THEME_FILES_DELETE_MUTATION, payload))


def cmd_migration_apply(args: argparse.Namespace) -> None:
    plan = read_json_file(args.file)
    operations: List[Tuple[str, Any]] = []
    for definition in plan.get("metafield_definitions", []):
        operations.append(("metafieldDefinitionCreate", {"definition": definition}))
    for definition in plan.get("metaobject_definitions", []):
        operations.append(("metaobjectDefinitionCreate", {"definition": definition}))
    for product in plan.get("products", []):
        operations.append(("productCreate", {"product": product.get("product", product), "media": product.get("media")}))
    if plan.get("metafields"):
        operations.append(("metafieldsSet", {"metafields": plan["metafields"]}))
    for metaobject in plan.get("metaobjects", []):
        operations.append(("metaobjectCreate", {"metaobject": metaobject.get("metaobject", metaobject)}))
    for file_input in plan.get("files_from_url", []):
        operations.append(("fileCreate", {"files": [file_input]}))

    if not dry_run_or_apply(args, "migrationApply", {"operationCount": len(operations), "operations": operations}):
        return

    cfg = load_config(args)
    mutation_by_name = {
        "metafieldDefinitionCreate": METAFIELD_DEFINITION_CREATE_MUTATION,
        "metaobjectDefinitionCreate": METAOBJECT_DEFINITION_CREATE_MUTATION,
        "productCreate": PRODUCT_CREATE_MUTATION,
        "metafieldsSet": METAFIELDS_SET_MUTATION,
        "metaobjectCreate": METAOBJECT_CREATE_MUTATION,
        "fileCreate": FILE_CREATE_MUTATION,
    }
    results = []
    for name, variables in operations:
        results.append({"operation": name, "result": admin_graphql(cfg, mutation_by_name[name], variables)})
    print_json({"ok": True, "results": results})


# ----------------------------- MCP-like manifest -----------------------------


def cmd_mcp_tools(args: argparse.Namespace) -> None:
    tools = [
        {"name": "auth-url", "purpose": "Generate Shopify OAuth authorization URL."},
        {"name": "token-client-credentials", "purpose": "Get Admin API access token for internal owned-store apps using client credentials."},
        {"name": "exchange-code", "purpose": "Exchange OAuth callback code for Admin API access token."},
        {"name": "shop-info", "purpose": "Read basic shop info to validate connection."},
        {"name": "scan-context", "purpose": "Export products, collections, files, metafields, metaobjects, themes, and optional pages/menus for Codex."},
        {"name": "products-list/product-get", "purpose": "Inspect product data and product metafields."},
        {"name": "product-create/product-update", "purpose": "Create/update product data. Dry-run unless --apply."},
        {"name": "metafield-definitions-list/metafield-definition-create", "purpose": "Inspect/create custom data schema for resources like PRODUCT."},
        {"name": "metafields-set", "purpose": "Set product/collection/page metafield values. Dry-run unless --apply."},
        {"name": "metaobject-definitions-list/metaobject-definition-create/metaobjects-list/metaobject-create", "purpose": "Manage structured custom content."},
        {"name": "files-list/file-create-url/staged-upload-target/staged-upload-file", "purpose": "Manage Shopify Files and upload staged media/assets."},
        {"name": "themes-list/theme-file-get/theme-files-upsert/theme-files-delete/theme-create/theme-publish", "purpose": "Inspect and mutate themes; theme write APIs require write_themes and Shopify exemption."},
        {"name": "migration-apply", "purpose": "Apply a JSON migration plan with dry-run default."},
        {"name": "graphql", "purpose": "Run arbitrary Admin GraphQL query/mutation for unsupported Shopify APIs."},
    ]
    print_json({"mcpLike": True, "transport": "cli", "safety": "write commands are dry-run unless --apply", "tools": tools})


def add_common_env_arg(p: argparse.ArgumentParser) -> None:
    p.add_argument("--env-file", default=os.environ.get("SHOPIFY_ENV_FILE", DEFAULT_ENV_FILE), help="Path to .env.shopify. Default: .env.shopify")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="shopify_codex_tool.py",
        description="MCP-like Shopify Admin GraphQL CLI for Codex/AI-assisted theme development.",
        epilog=(
            "Typical Codex flow:\n"
            "  1) python shopify_codex_tool.py env-example > .env.shopify\n"
            "  2) python shopify_codex_tool.py token-client-credentials --save\n"
            "     or python shopify_codex_tool.py auth-url ... then exchange-code --save\n"
            "  3) python shopify_codex_tool.py scan-context --include-content --out shopify-context.json\n"
            "  4) Let Codex read shopify-context.json + local theme source.\n"
            "  5) Codex creates migration JSON for metafields/metaobjects/products/files.\n"
            "  6) python shopify_codex_tool.py migration-apply --file migration.json         # dry run\n"
            "  7) python shopify_codex_tool.py migration-apply --file migration.json --apply # execute on dev store\n"
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    add_common_env_arg(parser)
    sub = parser.add_subparsers(dest="command", required=True)

    p = sub.add_parser("env-example", help="Print .env.shopify example.")
    p.set_defaults(func=cmd_env_example)

    p = sub.add_parser("mcp-tools", help="Print machine-readable tool manifest for Codex.")
    p.set_defaults(func=cmd_mcp_tools)

    p = sub.add_parser("auth-url", help="Generate OAuth install URL.")
    p.add_argument("--redirect-uri")
    p.add_argument("--scopes")
    p.add_argument("--state")
    p.set_defaults(func=cmd_auth_url)

    p = sub.add_parser("token-client-credentials", help="Get access token using client_credentials grant for owned-store internal apps.")
    p.add_argument("--save", action="store_true", help="Save token into .env.shopify as SHOPIFY_ACCESS_TOKEN.")
    p.add_argument("--show-token", action="store_true", help="Print token in terminal. Avoid in shared logs.")
    p.set_defaults(func=cmd_token_client_credentials)

    p = sub.add_parser("exchange-code", help="Exchange OAuth callback code for access token.")
    p.add_argument("--code", required=True)
    p.add_argument("--shop")
    p.add_argument("--save", action="store_true")
    p.add_argument("--show-token", action="store_true")
    p.set_defaults(func=cmd_exchange_code)

    p = sub.add_parser("verify-hmac", help="Verify Shopify callback/install query string HMAC.")
    p.add_argument("--query-string", required=True)
    p.set_defaults(func=cmd_verify_hmac)

    p = sub.add_parser("shop-info", help="Read basic shop info.")
    p.set_defaults(func=cmd_shop_info)

    p = sub.add_parser("graphql", help="Run arbitrary Admin GraphQL query/mutation.")
    p.add_argument("--query")
    p.add_argument("--query-file")
    p.add_argument("--variables", help="JSON object string merged into variables.")
    p.add_argument("--variables-file")
    p.set_defaults(func=cmd_graphql)

    p = sub.add_parser("scan-context", help="Export store context for Codex.")
    p.add_argument("--first", type=int, default=50)
    p.add_argument("--product-query")
    p.add_argument("--collection-query")
    p.add_argument("--file-query")
    p.add_argument("--include-content", action="store_true", help="Also try pages and menus; requires relevant scopes.")
    p.add_argument("--out")
    p.set_defaults(func=cmd_scan_context)

    p = sub.add_parser("products-list", help="List products with variants and metafields.")
    p.add_argument("--first", type=int, default=20)
    p.add_argument("--query")
    p.set_defaults(func=cmd_products_list)

    p = sub.add_parser("product-get", help="Get product by handle.")
    p.add_argument("--handle", required=True)
    p.set_defaults(func=cmd_product_get)

    p = sub.add_parser("product-create", help="Create product from JSON. Dry-run unless --apply.")
    p.add_argument("--json-file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_product_create)

    p = sub.add_parser("product-update", help="Update product from JSON. Dry-run unless --apply.")
    p.add_argument("--json-file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_product_update)

    p = sub.add_parser("collections-list", help="List collections.")
    p.add_argument("--first", type=int, default=20)
    p.add_argument("--query")
    p.set_defaults(func=cmd_collections_list)

    p = sub.add_parser("metafield-definitions-list", help="List metafield definitions by owner type.")
    p.add_argument("--owner-type", default="PRODUCT", help="Example: PRODUCT, COLLECTION, PAGE, SHOP")
    p.add_argument("--first", type=int, default=100)
    p.set_defaults(func=cmd_metafield_definitions_list)

    p = sub.add_parser("metafield-definition-create", help="Create metafield definition. Dry-run unless --apply.")
    p.add_argument("--json-file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_metafield_definition_create)

    p = sub.add_parser("metafields-set", help="Set metafield values. Dry-run unless --apply.")
    p.add_argument("--json-file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_metafields_set)

    p = sub.add_parser("metaobject-definitions-list", help="List metaobject definitions.")
    p.add_argument("--first", type=int, default=100)
    p.set_defaults(func=cmd_metaobject_definitions_list)

    p = sub.add_parser("metaobject-definition-create", help="Create metaobject definition. Dry-run unless --apply.")
    p.add_argument("--json-file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_metaobject_definition_create)

    p = sub.add_parser("metaobjects-list", help="List metaobjects by type.")
    p.add_argument("--type", required=True)
    p.add_argument("--first", type=int, default=50)
    p.set_defaults(func=cmd_metaobjects_list)

    p = sub.add_parser("metaobject-create", help="Create metaobject. Dry-run unless --apply.")
    p.add_argument("--json-file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_metaobject_create)

    p = sub.add_parser("files-list", help="List Shopify Files.")
    p.add_argument("--first", type=int, default=50)
    p.add_argument("--query")
    p.set_defaults(func=cmd_files_list)

    p = sub.add_parser("file-create-url", help="Create Shopify File from external URL. Dry-run unless --apply.")
    p.add_argument("--url", required=True)
    p.add_argument("--content-type", default="IMAGE", choices=["IMAGE", "FILE", "VIDEO", "EXTERNAL_VIDEO", "MODEL_3D"])
    p.add_argument("--alt")
    p.add_argument("--filename")
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_file_create_url)

    p = sub.add_parser("staged-upload-target", help="Create staged upload target for large/local file upload.")
    p.add_argument("--filename", required=True)
    p.add_argument("--mime-type")
    p.add_argument("--resource", default="FILE", help="Example: FILE, IMAGE, VIDEO, MODEL_3D")
    p.add_argument("--http-method", default="POST", choices=["POST", "PUT"])
    p.add_argument("--file-size", type=int)
    p.set_defaults(func=cmd_staged_upload_target)

    p = sub.add_parser("staged-upload-file", help="Upload a local file to a staged target JSON from staged-upload-target.")
    p.add_argument("--target-json", required=True)
    p.add_argument("--path", required=True)
    p.add_argument("--mime-type")
    p.add_argument("--file-field", default="file")
    p.set_defaults(func=cmd_staged_upload_file)

    p = sub.add_parser("themes-list", help="List online store themes.")
    p.add_argument("--first", type=int, default=50)
    p.set_defaults(func=cmd_themes_list)

    p = sub.add_parser("theme-file-get", help="Read theme file content by theme ID and filename.")
    p.add_argument("--theme-id", required=True)
    p.add_argument("--filename", action="append", help="Can be repeated. Use '*' to list files metadata.")
    p.set_defaults(func=cmd_theme_file_get)

    p = sub.add_parser("theme-files-upsert", help="Create/update theme text files. Dry-run unless --apply. Requires Shopify theme API exemption.")
    p.add_argument("--theme-id", required=True)
    p.add_argument("--file", action="append", required=True, help="Map theme filename to local path: templates/index.json=./templates/index.json")
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_theme_files_upsert)

    p = sub.add_parser("theme-files-delete", help="Delete theme files. Dry-run unless --apply. Requires Shopify theme API exemption.")
    p.add_argument("--theme-id", required=True)
    p.add_argument("--filename", action="append", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_theme_files_delete)

    p = sub.add_parser("theme-create", help="Create theme from public/staged ZIP URL. Dry-run unless --apply.")
    p.add_argument("--name")
    p.add_argument("--source", required=True)
    p.add_argument("--role", default="UNPUBLISHED", choices=["UNPUBLISHED", "DEVELOPMENT"])
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_theme_create)

    p = sub.add_parser("theme-publish", help="Publish a theme. Dry-run unless --apply.")
    p.add_argument("--theme-id", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_theme_publish)

    p = sub.add_parser("pages-list", help="List Online Store pages if API/scopes are available.")
    p.add_argument("--first", type=int, default=50)
    p.add_argument("--query")
    p.set_defaults(func=cmd_pages_list)

    p = sub.add_parser("menus-list", help="List menus/navigation if API/scopes are available.")
    p.add_argument("--first", type=int, default=50)
    p.set_defaults(func=cmd_menus_list)

    p = sub.add_parser("migration-apply", help="Apply migration JSON. Dry-run unless --apply.")
    p.add_argument("--file", required=True)
    p.add_argument("--apply", action="store_true")
    p.set_defaults(func=cmd_migration_apply)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    try:
        args.func(args)
        return 0
    except ToolError as exc:
        print_json({"ok": False, "error": str(exc)})
        return 1
    except KeyboardInterrupt:
        print_json({"ok": False, "error": "Interrupted"})
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
