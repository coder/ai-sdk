# Picks the chat model config id for a model hint ($hint), the way
# CoderChatClient.resolveModelConfigId does (packages/agent/src/coder/client.ts,
# resolveModelConfigId and joinOrgModels). Doctor uses this copy so that it
# never runs checkout code with the token. Update it when the resolver changes.
#
# Input: the body of GET /api/v2/organizations/<org>/chats/models, or the
# legacy GET /api/experimental/chats/model-configs array. Output: the id, or "".

def configs:
  if type == "array" then [.[] | select(type == "object")]
  else
    ([(.providers // [])[] | select(type == "object" and (.id | type) == "string" and (.type | type) == "string") | {key: .id, value: .type}] | from_entries) as $types
    | [(.models // [])[] | select(type == "object")
       | if (.ai_provider_id | type) == "string" and $types[.ai_provider_id] != null
         then . + {provider: $types[.ai_provider_id]} else . end]
  end;

def lc: if type == "string" then ascii_downcase else null end;

($hint | ascii_downcase) as $lower
| ($hint | index(":")) as $colon
| (if $colon == null then null else ($hint[0:$colon] | ascii_downcase) end) as $provider
| (if $colon == null then $lower else ($hint[$colon + 1:] | ascii_downcase) end) as $model
| if ($hint | test("^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"; "i")) then $hint
  else
    configs as $all
    | ([$all[] | select(.enabled != false)]) as $enabled
    | (if ($enabled | length) > 0 then $enabled else $all end) as $pool
    | (first($pool[] | select((.model | lc) == $model and ($provider == null or (.provider | lc) == $provider)))
       // first($pool[] | select((.model | lc) == $model))
       // first($pool[] | select(((.display_name | lc) // "") | contains($lower)))
       // first($pool[] | select(((.model | lc) // "") | contains($model)))
       // {id: ""}).id
  end
