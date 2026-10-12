| browser | core | op | status | load | exec | peak MB (one context) | notes |
|---|---|---|---|---|---|---|---|
| chromium 153.0.8010.12 | mt | trim_copy | ok | 98 ms | 1108 ms | 1040 |  |
| chromium 153.0.8010.12 | mt | x264_veryfast | ok | 78 ms | 4187 ms | 1031 |  |
| chromium 153.0.8010.12 | mt | xfade_join3 | hang | 81 ms | 300.0 s | – | timeout 300000 ms |
| chromium 153.0.8010.12 | mt | burn_ass | ok | 171 ms | 2168 ms | 1030 |  |
| chromium 153.0.8010.12 | mt | loudnorm | ok | 97 ms | 2673 ms | 1027 |  |
| chromium 153.0.8010.12 | mt | thumbnail | ok | 76 ms | 409 ms | 1026 |  |
| chromium 153.0.8010.12 | mt | ffprobe | ok | 91 ms | 287 ms | 1025 | exit code 0 |
| chromium 153.0.8010.12 | mt | soak60 | fail | 128 ms | 4159 ms | 1026 | 9/60 runs ok, median 412 ms/run; run 10 fail: [aac @ 0x246eb10] Qavg: nan |
| chromium 153.0.8010.12 | st | trim_copy | ok | 68 ms | 340 ms | 48 |  |
| chromium 153.0.8010.12 | st | x264_veryfast | ok | 41 ms | 11.1 s | 246 |  |
| chromium 153.0.8010.12 | st | xfade_join3 | ok | 46 ms | 12.0 s | 500 |  |
| chromium 153.0.8010.12 | st | burn_ass | ok | 48 ms | 5438 ms | 121 |  |
| chromium 153.0.8010.12 | st | loudnorm | ok | 43 ms | 1342 ms | 118 |  |
| chromium 153.0.8010.12 | st | thumbnail | ok | 42 ms | 308 ms | 40 |  |
| chromium 153.0.8010.12 | st | ffprobe | ok | 42 ms | 278 ms | 34 | exit code 0 |
| chromium 153.0.8010.12 | st | soak60 | crash | 39 ms | 640 ms | 34 | 1/60 runs ok, median 369 ms/run; run 2 crash: [aac @ 0x13aae00] Input contains (near) NaN/+-Inf |
| firefox 155.0 | mt | trim_copy | ok | 307 ms | 1320 ms | – |  |
| firefox 155.0 | mt | x264_veryfast | ok | 289 ms | 5023 ms | – |  |
| firefox 155.0 | mt | xfade_join3 | ok | 308 ms | 3347 ms | – |  |
| firefox 155.0 | mt | burn_ass | ok | 309 ms | 2508 ms | – |  |
| firefox 155.0 | mt | loudnorm | ok | 299 ms | 3501 ms | – |  |
| firefox 155.0 | mt | thumbnail | ok | 298 ms | 155 ms | – |  |
| firefox 155.0 | mt | ffprobe | ok | 292 ms | 14 ms | – | exit code 0 |
| firefox 155.0 | mt | soak60 | fail | 322 ms | 1516 ms | – | 6/60 runs ok, median 227 ms/run; run 7 fail: [aac @ 0x2384e20] Qavg: nan |
| firefox 155.0 | st | trim_copy | ok | 196 ms | 128 ms | – |  |
| firefox 155.0 | st | x264_veryfast | ok | 154 ms | 12.9 s | – |  |
| firefox 155.0 | st | xfade_join3 | ok | 155 ms | 14.2 s | – |  |
| firefox 155.0 | st | burn_ass | ok | 156 ms | 6368 ms | – |  |
| firefox 155.0 | st | loudnorm | ok | 146 ms | 1414 ms | – |  |
| firefox 155.0 | st | thumbnail | ok | 154 ms | 46 ms | – |  |
| firefox 155.0 | st | ffprobe | ok | 152 ms | 15 ms | – | exit code 0 |
| firefox 155.0 | st | soak60 | crash | 144 ms | 129 ms | – | 1/60 runs ok, median 121 ms/run; run 2 crash: [aac @ 0x13aae00] Input contains (near) NaN/+-Inf |
| webkit 26.6 | mt | trim_copy | ok | 115 ms | 935 ms | – |  |
| webkit 26.6 | mt | x264_veryfast | ok | 135 ms | 4551 ms | – |  |
| webkit 26.6 | mt | xfade_join3 | hang | 105 ms | 300.0 s | – | timeout 300000 ms |
| webkit 26.6 | mt | burn_ass | ok | 109 ms | 2200 ms | – |  |
| webkit 26.6 | mt | loudnorm | ok | 123 ms | 2677 ms | – |  |
| webkit 26.6 | mt | thumbnail | ok | 124 ms | 156 ms | – |  |
| webkit 26.6 | mt | ffprobe | ok | 126 ms | 26 ms | – | exit code 0 |
| webkit 26.6 | mt | soak60 | fail | 136 ms | 3048 ms | – | 21/60 runs ok, median 137 ms/run; run 22 fail: [aac @ 0x2386a30] Qavg: nan |
| webkit 26.6 | st | trim_copy | ok | 103 ms | 151 ms | – |  |
| webkit 26.6 | st | x264_veryfast | ok | 98 ms | 11.8 s | – |  |
| webkit 26.6 | st | xfade_join3 | ok | 79 ms | 12.8 s | – |  |
| webkit 26.6 | st | burn_ass | ok | 86 ms | 5785 ms | – |  |
| webkit 26.6 | st | loudnorm | ok | 84 ms | 1295 ms | – |  |
| webkit 26.6 | st | thumbnail | ok | 88 ms | 55 ms | – |  |
| webkit 26.6 | st | ffprobe | ok | 97 ms | 22 ms | – | exit code 0 |
| webkit 26.6 | st | soak60 | crash | 99 ms | 127 ms | – | 1/60 runs ok, median 119 ms/run; run 2 crash: [aac @ 0x13aae00] Input contains (near) NaN/+-Inf |
