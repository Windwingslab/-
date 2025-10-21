"""Very small YAML subset loader used when PyYAML is unavailable."""
from __future__ import annotations

from typing import List, Tuple

Token = Tuple[int, str]


def _tokenise(stream) -> List[Token]:
    if hasattr(stream, 'read'):
        text = stream.read()
    else:
        text = str(stream)
    tokens: List[Token] = []
    for line in text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        indent = len(line) - len(line.lstrip(" "))
        tokens.append((indent, line.strip()))
    return tokens


def _parse_scalar(value: str):
    if value.startswith(("'", '"')) and value.endswith(("'", '"')):
        return value[1:-1]
    if value.lower() in {"true", "false"}:
        return value.lower() == "true"
    try:
        if value.startswith("0") and len(value) > 1:
            raise ValueError
        return int(value)
    except ValueError:
        try:
            return float(value)
        except ValueError:
            return value


def _parse_block(tokens: List[Token], index: int, indent: int):
    result = None
    while index < len(tokens):
        current_indent, content = tokens[index]
        if current_indent < indent:
            break

        if content.startswith("- "):
            if result is None:
                result = []
            elif not isinstance(result, list):
                raise ValueError("Mixed list and mapping content")

            item_content = content[2:].strip()
            index += 1
            if item_content:
                if ":" in item_content:
                    key, value = item_content.split(":", 1)
                    item = {key.strip(): _parse_scalar(value.strip())}
                    child, index = _parse_block(tokens, index, current_indent + 2)
                    if isinstance(child, dict):
                        item.update(child)
                    elif child:
                        raise ValueError("List item expects mapping children")
                    result.append(item)
                else:
                    result.append(_parse_scalar(item_content))
            else:
                child, index = _parse_block(tokens, index, current_indent + 2)
                result.append(child)
        else:
            if result is None:
                result = {}
            elif not isinstance(result, dict):
                raise ValueError("Mixed mapping and list content")

            if ":" not in content:
                raise ValueError("Invalid mapping entry")
            key, value = content.split(":", 1)
            key = key.strip()
            value = value.strip()
            index += 1
            if value:
                result[key] = _parse_scalar(value)
            else:
                child, index = _parse_block(tokens, index, current_indent + 2)
                result[key] = child
    if result is None:
        result = {}
    return result, index


def safe_load(stream: str):
    tokens = _tokenise(stream)
    result, index = _parse_block(tokens, 0, 0)
    if index != len(tokens):
        raise ValueError("Failed to consume entire document")
    return result
