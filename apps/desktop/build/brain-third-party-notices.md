# Phosphor Brain: third-party notices

Phosphor Brain's optional local embeddings run in a separate utility process on
the third-party software below. It ships inside the application, but nothing
loads it until local embeddings are switched on. The embedding model is not
part of the application: it is downloaded only after an explicit
acknowledgement of its own terms.

Where a package carries its own licence file, that file ships unchanged in
`app.asar` under `node_modules/<package>/`.

| Package                           | Version | Licence                                  | Licence file shipped               |
| --------------------------------- | ------- | ---------------------------------------- | ---------------------------------- |
| `@huggingface/transformers`       | 4.3.2   | Apache-2.0                               | `LICENSE`                          |
| `@huggingface/tokenizers`         | 0.2.0   | Apache-2.0                               | `LICENSE`                          |
| `@huggingface/jinja`              | 0.5.11  | MIT, Copyright (c) 2023 Hugging Face     | `LICENSE`                          |
| `onnxruntime-node`                | 1.30.0  | MIT, Copyright (c) Microsoft Corporation | none in the npm package, see below |
| `onnxruntime-common`              | 1.30.0  | MIT, Copyright (c) Microsoft Corporation | none in the npm package, see below |
| `sharp`                           | 0.35.5  | Apache-2.0                               | `LICENSE`                          |
| `@img/sharp-darwin-arm64`         | 0.35.5  | Apache-2.0                               | `LICENSE`                          |
| `@img/sharp-libvips-darwin-arm64` | 1.3.4   | LGPL-3.0-or-later (libvips and others)   | none in the npm package, see below |
| `@img/colour`                     | 1.1.0   | MIT                                      | `LICENSE.md`                       |

Transformers.js also inlines code from ONNX Runtime Web
1.31.0-dev.20260914-8d85527a0 ("Copyright (c) Microsoft Corporation. All rights
reserved. Licensed under the MIT License."). Phosphor runs none of the
web/WASM backends and does not ship the `onnxruntime-web` package.

## ONNX Runtime

The `onnxruntime-node` and `onnxruntime-common` npm packages declare the MIT
licence and carry the header "Copyright (c) Microsoft Corporation. All rights
reserved." Their licence text is the ONNX Runtime project licence at
https://github.com/microsoft/onnxruntime/blob/main/LICENSE.

## libvips and its dependencies

`@img/sharp-libvips-darwin-arm64` 1.3.4 is a dynamically linked library
(`libvips-cpp.8.18.7.dylib`), unpacked under
`app.asar.unpacked/node_modules/@img/`. Its licensing, as the package states it:

| Library       | Used under the terms of                                   |
| ------------- | --------------------------------------------------------- |
| aom           | BSD 2-Clause + Alliance for Open Media Patent License 1.0 |
| cairo         | Mozilla Public License 1.1                                |
| cgif          | MIT License                                               |
| expat         | MIT License                                               |
| fontconfig    | fontconfig License (BSD-like)                             |
| freetype      | freetype License (BSD-like)                               |
| fribidi       | LGPLv3                                                    |
| glib          | LGPLv3                                                    |
| harfbuzz      | MIT License                                               |
| highway       | BSD 3-Clause                                              |
| lcms          | MIT License                                               |
| libarchive    | BSD 2-Clause                                              |
| libexif       | LGPLv3                                                    |
| libffi        | MIT License                                               |
| libheif       | LGPLv3                                                    |
| libimagequant | BSD 2-Clause                                              |
| libnsgif      | MIT License                                               |
| libpng        | libpng License                                            |
| librsvg       | LGPLv3                                                    |
| libtiff       | libtiff License (BSD-like)                                |
| libultrahdr   | MIT License                                               |
| libvips       | LGPLv3                                                    |
| libwebp       | New BSD License                                           |
| libxml2       | MIT License                                               |
| mozjpeg       | zlib License, IJG License, BSD 3-Clause                   |
| pango         | LGPLv3                                                    |
| pixman        | MIT License                                               |
| proxy-libintl | LGPLv3                                                    |
| zlib-ng       | zlib License                                              |

Use of libraries under the terms of the LGPLv3 is via the "any later version"
clause of the LGPLv2 or LGPLv2.1. Sources: https://github.com/lovell/sharp-libvips.
