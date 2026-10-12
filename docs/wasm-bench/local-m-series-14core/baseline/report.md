| browser | core | op | status | load | exec | peak MB (one context) | notes |
|---|---|---|---|---|---|---|---|
| chromium 153.0.8010.12 | mt | trim_copy | ok | 102 ms | 358 ms | 1040 |  |
| chromium 153.0.8010.12 | mt | x264_veryfast | ok | 106 ms | 5344 ms | 1031 |  |
| chromium 153.0.8010.12 | mt | xfade_join3 | hang | 114 ms | 300.0 s | – | timeout 300000 ms |
| chromium 153.0.8010.12 | mt | burn_ass | ok | 138 ms | 2581 ms | 1030 |  |
| chromium 153.0.8010.12 | mt | loudnorm | ok | 95 ms | 1368 ms | 1027 |  |
| chromium 153.0.8010.12 | mt | thumbnail | hang | 95 ms | 120.0 s | – | timeout 120000 ms |
| chromium 153.0.8010.12 | mt | ffprobe | ok | 91 ms | 292 ms | 1026 | exit code -1 |
| chromium 153.0.8010.12 | mt | soak60 | crash | 103 ms | 1563 ms | 1026 | 4/60 runs ok, median 318 ms/run; run 5 crash: [aac @ 0xebd480] Input contains (near) NaN/+-Inf |
| chromium 153.0.8010.12 | st | trim_copy | ok | 53 ms | 344 ms | 48 |  |
| chromium 153.0.8010.12 | st | x264_veryfast | ok | 43 ms | 13.7 s | 214 |  |
| chromium 153.0.8010.12 | st | xfade_join3 | ok | 49 ms | 14.2 s | 500 |  |
| chromium 153.0.8010.12 | st | burn_ass | ok | 48 ms | 6789 ms | 121 |  |
| chromium 153.0.8010.12 | st | loudnorm | ok | 44 ms | 1372 ms | 118 |  |
| chromium 153.0.8010.12 | st | thumbnail | ok | 44 ms | 313 ms | 34 |  |
| chromium 153.0.8010.12 | st | ffprobe | ok | 46 ms | 277 ms | 34 | exit code -1 |
| chromium 153.0.8010.12 | st | soak60 | crash | 39 ms | 647 ms | 34 | 1/60 runs ok, median 377 ms/run; run 2 crash: [aac @ 0xebaff0] Input contains (near) NaN/+-Inf |
| firefox 155.0 | mt | trim_copy | ok | 298 ms | 115 ms | – |  |
| firefox 155.0 | mt | x264_veryfast | ok | 281 ms | 5617 ms | – |  |
| firefox 155.0 | mt | xfade_join3 | ok | 277 ms | 4457 ms | – |  |
| firefox 155.0 | mt | burn_ass | ok | 293 ms | 2561 ms | – |  |
| firefox 155.0 | mt | loudnorm | ok | 274 ms | 1413 ms | – |  |
| firefox 155.0 | mt | thumbnail | ok | 289 ms | 199 ms | – |  |
| firefox 155.0 | mt | ffprobe | ok | 288 ms | 15 ms | – | exit code -1 |
| firefox 155.0 | mt | soak60 | crash | 294 ms | 176 ms | – | 3/60 runs ok, median 53 ms/run; run 4 crash: [aac @ 0xebd320] Input contains (near) NaN/+-Inf |
| firefox 155.0 | st | trim_copy | ok | 207 ms | 124 ms | – |  |
| firefox 155.0 | st | x264_veryfast | ok | 189 ms | 14.3 s | – |  |
| firefox 155.0 | st | xfade_join3 | ok | 152 ms | 15.2 s | – |  |
| firefox 155.0 | st | burn_ass | ok | 155 ms | 7096 ms | – |  |
| firefox 155.0 | st | loudnorm | ok | 151 ms | 1425 ms | – |  |
| firefox 155.0 | st | thumbnail | ok | 147 ms | 48 ms | – |  |
| firefox 155.0 | st | ffprobe | ok | 155 ms | 15 ms | – | exit code -1 |
| firefox 155.0 | st | soak60 | crash | 140 ms | 135 ms | – | 1/60 runs ok, median 126 ms/run; run 2 crash: [aac @ 0xebaff0] Input contains (near) NaN/+-Inf |
| webkit 26.6 | mt | trim_copy | ok | 130 ms | 165 ms | – |  |
| webkit 26.6 | mt | x264_veryfast | ok | 136 ms | 5076 ms | – |  |
| webkit 26.6 | mt | xfade_join3 | hang | 127 ms | 300.0 s | – | timeout 300000 ms |
| webkit 26.6 | mt | burn_ass | ok | 109 ms | 2288 ms | – |  |
| webkit 26.6 | mt | loudnorm | ok | 119 ms | 1304 ms | – |  |
| webkit 26.6 | mt | thumbnail | ok | 122 ms | 73 ms | – |  |
| webkit 26.6 | mt | ffprobe | ok | 120 ms | 24 ms | – | exit code -1 |
| webkit 26.6 | mt | soak60 | crash | 129 ms | 140 ms | – | 2/60 runs ok, median 94 ms/run; run 3 crash: [aac @ 0xebd1c0] Input contains (near) NaN/+-Inf |
| webkit 26.6 | st | trim_copy | ok | 117 ms | 153 ms | – |  |
| webkit 26.6 | st | x264_veryfast | ok | 114 ms | 13.0 s | – |  |
| webkit 26.6 | st | xfade_join3 | ok | 95 ms | 13.6 s | – |  |
| webkit 26.6 | st | burn_ass | ok | 104 ms | 6349 ms | – |  |
| webkit 26.6 | st | loudnorm | ok | 104 ms | 1307 ms | – |  |
| webkit 26.6 | st | thumbnail | ok | 108 ms | 55 ms | – |  |
| webkit 26.6 | st | ffprobe | ok | 102 ms | 23 ms | – | exit code -1 |
| webkit 26.6 | st | soak60 | crash | 105 ms | 132 ms | – | 1/60 runs ok, median 123 ms/run; run 2 crash: [aac @ 0xebaff0] Input contains (near) NaN/+-Inf |
