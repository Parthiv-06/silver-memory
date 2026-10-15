"""
graph.py — Request/response schemas and body handling for the knowledge graph.

PUT /graph reads its own body instead of letting FastAPI parse it, so a
15 MB cap can be enforced before any JSON is decoded. This module holds the
limits, the pydantic models that mirror the frontend's GraphData type
(frontend/lib/graph/types.ts), and the helpers that turn a raw body into a
validated upload or a FastAPI-style 422.

Nodes and links are TypedDicts rather than models: pydantic validates them
into plain dicts, which is ~10x faster than building 300k model instances
and can be written straight back out with json.dumps.
"""

import json
from typing import Annotated, Any, NoReturn, Optional, Union

from fastapi import HTTPException, Request, status
from fastapi.exceptions import RequestValidationError
from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    ValidationError,
    field_validator,
    model_validator,
    with_config,
)
from pydantic_core import PydanticCustomError
from starlette.requests import ClientDisconnect
# typing_extensions ships with pydantic; pydantic needs its TypedDict on Python < 3.12
from typing_extensions import NotRequired, TypedDict


# ---------------------------------------------------------------------------
# Limits
# ---------------------------------------------------------------------------

MAX_BODY_BYTES = 15 * 1024 * 1024  # whole PUT body, checked before JSON parsing
MAX_NODES = 50_000
MAX_LINKS = 250_000
MAX_ID_CHARS = 512                 # node id / label (and link ends, which must match an id)
MAX_GROUP_CHARS = 120              # group names, group colours, each tag
MAX_TAGS = 32
MAX_GROUPS = 10_000                # entries in the optional `groups` style map
MAX_META_BYTES = 4 * 1024          # per node, measured as compact UTF-8 JSON
MAX_SOURCE_CHARS = 200
MAX_REPORTED_ERRORS = 20           # cap on 422 detail entries


# ---------------------------------------------------------------------------
# GraphData schemas (mirror frontend/lib/graph/types.ts)
# ---------------------------------------------------------------------------

NodeId = Annotated[str, StringConstraints(min_length=1, max_length=MAX_ID_CHARS)]
Label = Annotated[str, StringConstraints(max_length=MAX_ID_CHARS)]
ShortText = Annotated[str, StringConstraints(max_length=MAX_GROUP_CHARS)]

# strict: JSON types only — no "true" -> True or "1.5" -> 1.5 coercion
STRICT = ConfigDict(strict=True)


@with_config(STRICT)
class GraphNode(TypedDict):
    """A note. `id` is the key links point at; `label` is what people read."""

    id: NodeId
    label: Label
    group: NotRequired[Optional[ShortText]]
    tags: NotRequired[Optional[Annotated[list[ShortText], Field(max_length=MAX_TAGS)]]]
    unresolved: NotRequired[Optional[bool]]
    meta: NotRequired[Optional[dict[str, Any]]]  # stored as-is; size-checked below


@with_config(STRICT)
class GraphLink(TypedDict):
    """A directed link between two node ids. Self-links are allowed."""

    source: NodeId
    target: NodeId
    weight: NotRequired[Optional[Annotated[float, Field(allow_inf_nan=False)]]]


@with_config(STRICT)
class GraphGroupStyle(TypedDict):
    """Optional per-group display hints."""

    label: NotRequired[Optional[Label]]
    color: NotRequired[Optional[ShortText]]


class GraphData(BaseModel):
    model_config = STRICT

    # fail_fast: stop at the first bad node / link. Without it a 15 MB body of wrong
    # types makes pydantic record millions of errors (GBs of memory) to report 20.
    nodes: list[GraphNode] = Field(max_length=MAX_NODES, fail_fast=True)
    links: list[GraphLink] = Field(max_length=MAX_LINKS, fail_fast=True)
    groups: Optional[dict[ShortText, GraphGroupStyle]] = Field(default=None, max_length=MAX_GROUPS)

    @model_validator(mode="after")
    def check_references(self) -> "GraphData":
        """Unique node ids, links that resolve, meta size. One pass over each list."""
        first_seen: dict[str, int] = {}
        for i, node in enumerate(self.nodes):
            first = first_seen.setdefault(node["id"], i)
            if first != i:
                raise PydanticCustomError(
                    "graph_duplicate_id",
                    "nodes[{index}].id {id} is already used by nodes[{first}]",
                    {"index": i, "first": first, "id": _quote(node["id"])},
                )
            if node.get("meta"):
                _check_meta(i, node["meta"])

        for i, link in enumerate(self.links):
            if link["source"] not in first_seen:
                _dangling(i, "source", link["source"])
            if link["target"] not in first_seen:
                _dangling(i, "target", link["target"])
        return self

    def to_json(self) -> str:
        """Compact JSON of exactly what was sent (minus unknown keys), for storage."""
        doc: dict[str, Any] = {"nodes": self.nodes, "links": self.links}
        if "groups" in self.model_fields_set:
            doc["groups"] = self.groups
        # ensure_ascii=False is safe: every string is either pydantic-checked
        # or (meta) encoded strictly in _check_meta, so no lone surrogates.
        return json.dumps(doc, ensure_ascii=False, separators=(",", ":"))


def _quote(text: str, limit: int = 60) -> str:
    """JSON-quote an id for an error message, shortened so messages stay small."""
    return json.dumps(text if len(text) <= limit else text[:limit] + "…", ensure_ascii=False)


def _dangling(index: int, end: str, node_id: str) -> NoReturn:
    raise PydanticCustomError(
        "graph_unknown_node",
        "links[{index}].{end} {id} does not match any node id",
        {"index": index, "end": end, "id": _quote(node_id)},
    )


def _check_meta(index: int, meta: dict):
    try:
        size = len(
            json.dumps(meta, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
        )
    except (ValueError, RecursionError):  # inf/nan (e.g. 1e999), lone surrogates
        raise PydanticCustomError(
            "graph_meta_invalid",
            "nodes[{index}].meta must be plain JSON (finite numbers, valid Unicode)",
            {"index": index},
        )
    if size > MAX_META_BYTES:
        raise PydanticCustomError(
            "graph_meta_too_large",
            "nodes[{index}].meta is {size} bytes as JSON; the limit is {limit}",
            {"index": index, "size": size, "limit": MAX_META_BYTES},
        )


# ---------------------------------------------------------------------------
# Request / Response schemas
# ---------------------------------------------------------------------------

class GraphUpload(BaseModel):
    """PUT /graph body."""

    model_config = STRICT

    graph: GraphData
    source: str = Field(max_length=MAX_SOURCE_CHARS, examples=["Obsidian vault: My Vault"])

    @field_validator("source")
    @classmethod
    def no_nul(cls, value: str) -> str:
        # Postgres text columns can't hold NUL; graph strings are fine (stored JSON escapes them).
        if "\x00" in value:
            raise PydanticCustomError("graph_source_invalid", "source must not contain NUL characters")
        return value


class GraphSummary(BaseModel):
    """What PUT /graph returns, and the metadata half of GET /graph."""

    source: str
    updated_at: str = Field(description="ISO-8601, UTC", examples=["2026-10-15T09:30:00.000Z"])
    nodes: int
    links: int


class GraphResponse(GraphSummary):
    """GET /graph."""

    graph: GraphData


def upload_openapi() -> dict:
    """
    OpenAPI request body for PUT /graph, which FastAPI can't infer because the
    route reads the body itself. The node/link schemas are referenced from
    components, where GET /graph's GraphResponse already registers them.
    """
    schema = GraphUpload.model_json_schema(ref_template="#/components/schemas/{model}")
    schema.pop("$defs", None)
    return {
        "requestBody": {
            "required": True,
            "content": {"application/json": {"schema": schema}},
        }
    }


# ---------------------------------------------------------------------------
# Body handling
# ---------------------------------------------------------------------------

def _too_large() -> HTTPException:
    return HTTPException(
        status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
        detail=f"Request body is larger than {MAX_BODY_BYTES // (1024 * 1024)} MB",
    )


async def read_limited_body(request: Request) -> bytearray:
    """
    FastAPI dependency — returns the raw body, or 413 past MAX_BODY_BYTES.

    Content-Length is checked first so oversized uploads are refused before a
    byte is read; the running total is checked too, so a chunked upload or a
    missing/lying header can't get past the cap.
    """
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            too_big = int(declared) > MAX_BODY_BYTES
        except ValueError:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Invalid Content-Length header")
        if too_big:
            raise _too_large()

    body = bytearray()
    try:
        async for chunk in request.stream():
            body += chunk
            if len(body) > MAX_BODY_BYTES:
                raise _too_large()
    except ClientDisconnect:
        # The client went away mid-upload (closed tab, aborted fetch): nothing to answer.
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload was interrupted")
    return body  # json.loads takes a bytearray, so no 15 MB copy


class _ConstantNotAllowed(ValueError):
    pass


def _reject_constant(name: str) -> NoReturn:
    raise _ConstantNotAllowed(f"{name} is not allowed")


def parse_graph_upload(raw: Union[bytes, bytearray]) -> GraphUpload:
    """Decode + validate a PUT /graph body. Raises RequestValidationError (422)."""
    try:
        payload = json.loads(raw, parse_constant=_reject_constant)
    except RecursionError:
        raise _invalid_json("nested too deeply")
    except json.JSONDecodeError as exc:
        raise _invalid_json(f"{exc.msg} (line {exc.lineno}, column {exc.colno})")
    except UnicodeDecodeError:
        raise _invalid_json("body is not valid UTF-8")
    except _ConstantNotAllowed as exc:  # NaN, Infinity, -Infinity
        raise _invalid_json(str(exc))
    except ValueError:  # e.g. an integer past Python's 4300-digit limit
        raise _invalid_json("a number is too long or a value is not allowed")

    try:
        return GraphUpload.model_validate(payload)
    except ValidationError as exc:
        raise RequestValidationError(_validation_detail(exc))


def _invalid_json(reason: str) -> RequestValidationError:
    return RequestValidationError(
        [{"type": "json_invalid", "loc": ["body"], "msg": f"Request body is not valid JSON: {reason}"}]
    )


# ---------------------------------------------------------------------------
# 422 messages: FastAPI's detail shape, with a msg that names the exact field
# ---------------------------------------------------------------------------

_MESSAGES = {
    "missing": "{path} is required",
    "string_type": "{path} must be a string",
    "string_unicode": "{path} is not valid Unicode text",
    "string_too_short": "{path} must not be empty",
    "string_too_long": "{path} is longer than {max_length} characters",
    "too_long": "{path} has {actual_length:,} entries; the limit is {max_length:,}",
    "bool_type": "{path} must be true or false",
    "float_type": "{path} must be a number",
    "finite_number": "{path} must be a finite number",
    "list_type": "{path} must be an array",
    "dict_type": "{path} must be an object",
    "model_type": "{path} must be an object",
}


def _readable_path(loc: tuple) -> str:
    """("graph", "nodes", 12, "label") -> "nodes[12].label" — GraphData fields read as top-level."""
    parts = loc[1:] if len(loc) > 1 and loc[0] == "graph" else loc
    path = ""
    for part in parts:
        if isinstance(part, int):
            path += f"[{part}]"
        elif part == "[key]":  # pydantic's marker for a bad dict key
            path += " key"
        else:
            name = part if len(part) <= 60 else part[:60] + "…"
            path += f".{name}" if path else name
    return path or "body"


def _cross_check_loc(err: dict) -> tuple:
    """Where a GraphData cross-check (raised for the whole graph) actually points."""
    ctx = err.get("ctx") or {}
    kind = err["type"]
    if kind == "graph_unknown_node":
        return ("graph", "links", ctx["index"], ctx["end"])
    if kind == "graph_duplicate_id":
        return ("graph", "nodes", ctx["index"], "id")
    if kind in ("graph_meta_invalid", "graph_meta_too_large"):
        return ("graph", "nodes", ctx["index"], "meta")
    return tuple(err["loc"])


def _validation_detail(exc: ValidationError) -> list[dict]:
    # Bounded: nodes/links stop at their first bad item (fail_fast), groups at MAX_GROUPS.
    errors = exc.errors(include_url=False, include_input=False)
    detail = []
    for err in errors[:MAX_REPORTED_ERRORS]:
        path = _readable_path(err["loc"])
        template = _MESSAGES.get(err["type"])
        if err["type"].startswith("graph_"):
            msg = err["msg"]  # cross-checks already name the exact field
            try:
                err = {**err, "loc": _cross_check_loc(err)}
            except (KeyError, TypeError):
                pass
        elif template:
            try:
                msg = template.format(path=path, **err.get("ctx", {}))
            except (KeyError, ValueError, TypeError):
                msg = f"{path}: {err['msg']}"
        else:
            msg = f"{path}: {err['msg']}"
        detail.append({"type": err["type"], "loc": ["body", *err["loc"]], "msg": msg})

    if len(errors) > MAX_REPORTED_ERRORS:
        detail.append({
            "type": "too_many_errors",
            "loc": ["body"],
            "msg": f"…and {len(errors) - MAX_REPORTED_ERRORS:,} more problems",
        })
    return detail
