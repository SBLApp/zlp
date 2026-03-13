curl ^"https://api-p01.samokat.ru/wmsout-wwh/picking-selection/tasks^" ^
  -H ^"Accept: application/json^" ^
  -H ^"Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7^" ^
  -H ^"Authorization: Bearer eyJraWQiOiI2MTg2OTEiLCJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI2MjAxNzkwMjQxIiwiaWF0IjoxNzczMzU0MDc0LCJleHAiOjE3NzMzNTQzNzQsImF1ZCI6Imh0dHBzOi8vc2Ftb2thdC5ydSIsInNjb3BlIjpbIndtc19jaGllZl9zdG9ja21hbiJdLCJjbGllbnRfaWQiOiJXTVMiLCJkZXZpY2VfaWQiOm51bGwsInVzZXIiOnsidXNlcklkIjoiYTE1NzRmMGYtMTkyYi00N2QwLTgyNDYtOWJkYjNhYTllZTM5IiwidXNlclR5cGUiOiIifSwic3ViIjoiYTE1NzRmMGYtMTkyYi00N2QwLTgyNDYtOWJkYjNhYTllZTM5In0.cuxb-8FqmziWAnL8epMxqqgPCKTddeBOk8JMUD0CYuvdH-IcykSYuwX5nZ7USqwr091V9qMBvq4ne5QznAcmRJW6S0RCZYdAtFdTXixEXvu9KUfBYPLqrYEq44oeR4naVmrXckRCjbhMWwdM2inkOpzKV3OG_vNEnVZSfGepYhc^" ^
  -H ^"Cache-Control: no-cache^" ^
  -H ^"Connection: keep-alive^" ^
  -H ^"Content-Type: application/json^" ^
  -H ^"Origin: https://wwh.samokat.ru^" ^
  -H ^"Pragma: no-cache^" ^
  -H ^"Referer: https://wwh.samokat.ru/^" ^
  -H ^"Sec-Fetch-Dest: empty^" ^
  -H ^"Sec-Fetch-Mode: cors^" ^
  -H ^"Sec-Fetch-Site: same-site^" ^
  -H ^"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36^" ^
  -H ^"sec-ch-ua: ^\^"Not:A-Brand^\^";v=^\^"99^\^", ^\^"Google Chrome^\^";v=^\^"145^\^", ^\^"Chromium^\^";v=^\^"145^\^"^" ^
  -H ^"sec-ch-ua-mobile: ?0^" ^
  -H ^"sec-ch-ua-platform: ^\^"Windows^\^"^" ^
  --data-raw ^"^{^\^"dateFrom^\^":^\^"2026-03-12T21:00:00.000Z^\^",^\^"dateTo^\^":^\^"2026-03-13T20:59:59.999Z^\^",^\^"status^\^":^[^\^"COMPLETED^\^"^],^\^"shipToId^\^":null,^\^"sourceZoneId^\^":^[^\^"0b29f9ce-9549-435e-b7c2-ecdd3e937057^\^",^\^"c976ff6d-865c-472c-a754-cee17e93e63d^\^"^],^\^"shipmentTemperatureMode^\^":null,^\^"shipmentNumber^\^":null,^\^"routeNumber^\^":null,^\^"targetHandlingUnitBarcode^\^":null,^\^"responsibleUserId^\^":null,^\^"pageNumber^\^":1,^\^"pageSize^\^":100^}^"




URL запроса
https://api-p01.samokat.ru/wmsout-wwh/picking-selection/tasks
Метод запроса
POST
Код статуса
200 OK
Удаленный адрес
109.238.88.252:443
Правило для URL перехода
strict-origin-when-cross-origin


HTTP/1.1 200 OK
Server: nginx
Date: Thu, 12 Mar 2026 21:48:18 GMT
Content-Type: application/json
Transfer-Encoding: chunked
Connection: keep-alive
Keep-Alive: timeout=15
set-cookie: spid=1773352098033_0f0fa2c50d027a696969875446e86198_9uqoxhaj81165jk4; Expires=Tue, 19 Jan 2038 03:14:07 GMT; Path=/; Secure; SameSite=None
vary: Accept-Encoding
vary: Origin
vary: Access-Control-Request-Method
vary: Access-Control-Request-Headers
x-content-type-options: nosniff
x-xss-protection: 0
cache-control: no-cache, no-store, max-age=0, must-revalidate
pragma: no-cache
expires: 0
x-frame-options: DENY
access-control-allow-origin: *
access-control-allow-credentials: true
access-control-allow-methods: PUT, GET, POST, OPTIONS
access-control-allow-headers: DNT,Keep-Alive,User-Agent,X-Requested-With,If-Modified-Since,Cache-Control,Content-Type,Range,Authorization
access-control-max-age: 1728000
content-encoding: br
X-SP-CRID: 28051006057:8

POST /wmsout-wwh/picking-selection/tasks HTTP/1.1
Accept: application/json
Accept-Encoding: gzip, deflate, br, zstd
Accept-Language: ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7
Authorization: Bearer eyJraWQiOiI2MTg2OTEiLCJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI2MjAxNzYwMzM4IiwiaWF0IjoxNzczMzUxOTUyLCJleHAiOjE3NzMzNTIyNTIsImF1ZCI6Imh0dHBzOi8vc2Ftb2thdC5ydSIsInNjb3BlIjpbIndtc19jaGllZl9zdG9ja21hbiJdLCJjbGllbnRfaWQiOiJXTVMiLCJkZXZpY2VfaWQiOm51bGwsInVzZXIiOnsidXNlcklkIjoiYTE1NzRmMGYtMTkyYi00N2QwLTgyNDYtOWJkYjNhYTllZTM5IiwidXNlclR5cGUiOiIifSwic3ViIjoiYTE1NzRmMGYtMTkyYi00N2QwLTgyNDYtOWJkYjNhYTllZTM5In0.hOvpaYLhDMAZzGUqDs5wYgGL3LSXXXiZx2N8eCnmfMVzFFA8-Mzx02eLkHUd9Hndn7wYzy46uEQGCSDGht_z5xSZyNugJLkvSw9eFMPX8PYnjEAnF49AYLunXKcABAVLCUT4EtrUqEEIcRu5X4r4PC1tdq6WFlY0UKql4ux4Bn4
Cache-Control: no-cache
Connection: keep-alive
Content-Length: 321
Content-Type: application/json
Host: api-p01.samokat.ru
Origin: https://wwh.samokat.ru
Pragma: no-cache
Referer: https://wwh.samokat.ru/
Sec-Fetch-Dest: empty
Sec-Fetch-Mode: cors
Sec-Fetch-Site: same-site
User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36
sec-ch-ua: "Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"
sec-ch-ua-mobile: ?0
sec-ch-ua-platform: "Windows"


{"dateFrom":"2026-03-12T21:00:00.000Z","dateTo":"2026-03-13T20:59:59.999Z","status":["COMPLETED"],"shipToId":null,"sourceZoneId":["0b29f9ce-9549-435e-b7c2-ecdd3e937057","c976ff6d-865c-472c-a754-cee17e93e63d"],"shipmentTemperatureMode":null,"shipmentNumber":null,"routeNumber":null,"targetHandlingUnitBarcode":null,"responsibleUserId":null,"pageNumber":1,"pageSize":100}

-{"dateFrom":"2026-03-12T21:00:00.000Z","dateTo":"2026-03-13T20:59:59.999Z"
дата отгрузки всегда +1 день к сегодня 

-status":["COMPLETED"] выполнено 

"sourceZoneId":["0b29f9ce-9549-435e-b7c2-ecdd3e937057","c976ff6d-865c-472c-a754-cee17e93e63d"],
зоны Сухой и Холод

затем мы узнаем total 

и делаем запрос на 1000 pageSize":1000} 
и pageNumber":1, паганацию 


в ответ мы получим :

{
    "value": {
        "items": [
            {
                "id": "91461835-03f4-43d3-9aca-5362398f0034",
                "status": "COMPLETED",
                "shipTo": {
                    "id": "5f34c135-f3f5-11ed-b971-08c0eb32008b",
                    "name": "СПБ Толубеевский пр-д 8к2",
                    "address": "194292, Санкт-Петербург г, Толубеевский проезд, дом 8, корпус 2, строение 1",
                    "timezoneOrDefault": "+03:00"
                },
                "sourceZone": {
                    "id": "c976ff6d-865c-472c-a754-cee17e93e63d",
                    "name": "Холод"
                },
                "targetHandlingUnitBarcode": "022200202157",
                "logisticDate": "2026-03-13",
                "volumeInMilliliters": 543408,
                "weightInGrams": 246743,
                "shipmentTemperatureModes": [
                    "MEDIUM_COLD"
                ],
                "shipmentNumbers": [
                    "00284289332",
                    "00284380432",
                    "00284380393"
                ],
                "sourceCellsCount": 70,
                "routeNumber": "20260313-61",
                "responsibleUser": {
                    "id": "7274dc6d-2048-43e6-8e63-1428d85dd3b9",
                    "firstName": "Алексей",
                    "lastName": "Гонзуревский",
                    "middleName": "Владимирович"
                },
                "createdAt": "2026-03-12T17:54:38.780134Z"
            },





пояснения 
   "sourceCellsCount": 70, = количество задач в хранении 
    "name": "Холод" = блок 
     "weightInGrams": 246743, = вес мы покажем в тоннах 
     "volumeInMilliliters": 543408 = обьем покажем в литрах
    "targetHandlingUnitBarcode": "022200202157", = единица обработки 


--- Тест (подставь свой Bearer TOKEN) ---
Формат дат только «логистические сутки»: dateFrom = (день-1)T21:00:00.000Z, dateTo = день T20:59:59.999Z.
Иначе API возвращает {"error":"INVALID_FILTER_REQUEST"}.

PowerShell (одна строка, замени YOUR_TOKEN):
$h = @{ "Accept"="application/json"; "Content-Type"="application/json"; "Authorization"="Bearer eyJraWQiOiI2MTg2OTEiLCJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJqdGkiOiI2MjAxODI1NTk0IiwiaWF0IjoxNzczMzU2ODc2LCJleHAiOjE3NzMzNTcxNzYsImF1ZCI6Imh0dHBzOi8vc2Ftb2thdC5ydSIsInNjb3BlIjpbIndtc19jaGllZl9zdG9ja21hbiJdLCJjbGllbnRfaWQiOiJXTVMiLCJkZXZpY2VfaWQiOm51bGwsInVzZXIiOnsidXNlcklkIjoiYTE1NzRmMGYtMTkyYi00N2QwLTgyNDYtOWJkYjNhYTllZTM5IiwidXNlclR5cGUiOiIifSwic3ViIjoiYTE1NzRmMGYtMTkyYi00N2QwLTgyNDYtOWJkYjNhYTllZTM5In0.Ge_S8taVlS_iQLY_WI7GGiqHWCdvW0JD08boX74VzIDDy8p43qb592k2DP4fNKq5_DJY6Vh4tL27iFdn7DFcq-SWyIuvv0TDsyHVyCvfRo6YEWnOOWnuCRCExdOFbDodJJ4YGkY1YWP0oA1ByhKmb_ZcblImZW4s5Sb39qX2tOg"; "Origin"="https://wwh.samokat.ru" }; $body = '{"dateFrom":"2026-03-11T21:00:00.000Z","dateTo":"2026-03-12T20:59:59.999Z","status":["COMPLETED"],"shipToId":null,"sourceZoneId":["0b29f9ce-9549-435e-b7c2-ecdd3e937057","c976ff6d-865c-472c-a754-cee17e93e63d"],"shipmentTemperatureMode":null,"shipmentNumber":null,"routeNumber":null,"targetHandlingUnitBarcode":null,"responsibleUserId":null,"pageNumber":1,"pageSize":100}'; Invoke-RestMethod -Uri "https://api-p01.samokat.ru/wmsout-wwh/picking-selection/tasks" -Method Post -Headers $h -Body $body

Если ответ без "error" и есть value.items — запрос корректен.

