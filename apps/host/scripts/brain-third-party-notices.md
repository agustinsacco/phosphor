# Phosphor Host Brain: third-party notices

These dependencies are only in the qualified macOS arm64 Brain runtime. The
embedding model is separate and is not redistributed in the Host bundle.

- Hugging Face Transformers.js (Apache-2.0), including inlined Hugging Face
  Tokenizers (Apache-2.0) and Jinja (MIT). See their original `LICENSE` files in
  `lib/node_modules/brain-transformers`, `brain-tokenizers` and `brain-jinja`.
- ONNX Runtime Node and ONNX Runtime Common (MIT); Transformers also inlines
  code from ONNX Runtime Web (MIT), without shipping WASM binaries or using WASM
  inference. See the MIT text below and
  <https://github.com/microsoft/onnxruntime/blob/v1.30.0/ThirdPartyNotices.txt>.
- sharp and its macOS arm64 addon (Apache-2.0), colour (MIT), detect-libc
  (Apache-2.0) and semver (ISC): their upstream license files are shipped
  alongside them. This build relocates scoped packages to archive-safe paths
  and changes the corresponding module specifiers in three shipped sharp files.
- libvips is dynamically linked; its prebuilt package is LGPL-3.0-or-later.
  Its upstream README lists components and licenses; `versions.json` names the
  component versions. See also <https://github.com/lovell/sharp-libvips>.

## ONNX Runtime — MIT License

Copyright (c) Microsoft Corporation. All rights reserved.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
