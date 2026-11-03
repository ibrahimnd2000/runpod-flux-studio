# curl examples

```bash
set -a; source .env; set +a      # RUNPOD_API_KEY, RUNPOD_IMAGE_ENDPOINT_ID
EP=https://api.runpod.ai/v2/$RUNPOD_IMAGE_ENDPOINT_ID
AUTH="Authorization: Bearer $RUNPOD_API_KEY"
```

## Synchronous: wait for the image

```bash
curl -s -X POST $EP/runsync -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"input":{"prompt":"A studio product photo of a ceramic coffee mug on a walnut table","seed":42}}' \
  | python3 -c 'import json,sys,base64; r=json.load(sys.stdin); open("mug.png","wb").write(base64.b64decode(r["output"]["images"][0])); print(r["status"], r["delayTime"], r["executionTime"])'
```

`/runsync` holds the connection until the job finishes and keeps results for about 1 minute. Use it for quick
calls on a warm endpoint. `scripts/generate.sh "prompt" out.png` wraps this.

## Asynchronous: submit, then poll

```bash
JOB=$(curl -s -X POST $EP/run -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"input":{"prompt":"White running shoes on a concrete plinth","num_inference_steps":28}}' | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])')

curl -s $EP/status/$JOB -H "$AUTH"   # IN_QUEUE -> IN_PROGRESS (output = {"step": n, "total_steps": 28}) -> COMPLETED
```

Async results are kept for about 30 minutes. Prefer `/run` when a cold start is likely or for many jobs.

## Endpoint health

```bash
curl -s $EP/health -H "$AUTH"        # worker states and job counters
```

## Validation errors

```bash
curl -s -X POST $EP/runsync -H "$AUTH" -H 'Content-Type: application/json' -d '{"input":{"prompt":""}}'
# {"status":"FAILED","error":"prompt must be a non-empty string", ...}
```

## Through the hosted demo app (no Runpod key, needs the access code)

```bash
APP=https://t2jragqmgaorlq-3000.proxy.runpod.net
curl -s -X POST $APP/api/generate -H 'Content-Type: application/json' -H "x-access-code: $CODE" \
  -d '{"prompt":"A glass bottle of olive oil beside rosemary on linen","width":1024,"height":1024}'
# {"id":"<job id>",...}  then poll:  curl -s $APP/api/jobs/<job id>
```
