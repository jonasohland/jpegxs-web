// Uploads the three decoded planes as single-channel textures and converts
// YUV to RGB in the fragment shader. Unlike the WebCodecs sample's
// WebGLRenderer, no VideoFrame (and no browser-side conversion) is involved.

const vertexShaderSource = `
  attribute vec2 xy;
  varying highp vec2 uv;
  void main(void) {
    gl_Position = vec4(xy, 0.0, 1.0);
    // Map vertex coordinates (-1 to +1) to UV coordinates (0 to 1).
    // UV coordinates are Y-flipped relative to vertex coordinates.
    uv = vec2((1.0 + xy.x) / 2.0, (1.0 - xy.y) / 2.0);
  }
`;

const fragmentShaderSource = `
  precision mediump float;
  varying highp vec2 uv;
  uniform sampler2D planeY;
  uniform sampler2D planeU;
  uniform sampler2D planeV;
  uniform mediump mat3 yuvToRgb;
  uniform mediump vec3 yuvOffset;
  void main(void) {
    mediump vec3 yuv = vec3(
      texture2D(planeY, uv).r,
      texture2D(planeU, uv).r,
      texture2D(planeV, uv).r) - yuvOffset;
    gl_FragColor = vec4(yuvToRgb * yuv, 1.0);
  }
`;

// Luma coefficients (Kr, Kb) per VideoColorSpace matrix.
const COEFFICIENTS = {
  bt709: [0.2126, 0.0722],
  bt470bg: [0.299, 0.114],
  smpte170m: [0.299, 0.114],
  bt2020_ncl: [0.2627, 0.0593],
};

/** Column-major YUV → RGB matrix and offsets for 8-bit samples in [0, 1]. */
function conversion(colorSpace) {
  const [kr, kb] = COEFFICIENTS[colorSpace?.matrix] ?? COEFFICIENTS.bt709;
  const kg = 1 - kr - kb;
  const full = colorSpace?.fullRange === true;
  const ys = full ? 1 : 255 / 219;
  const cs = full ? 1 : 255 / 224;
  // Columns: contribution of Y, Cb, Cr to (R, G, B).
  const matrix = new Float32Array([
    ys, ys, ys,
    0, (-cs * 2 * kb * (1 - kb)) / kg, cs * 2 * (1 - kb),
    cs * 2 * (1 - kr), (-cs * 2 * kr * (1 - kr)) / kg, 0,
  ]);
  const offset = new Float32Array([full ? 0 : 16 / 255, 128 / 255, 128 / 255]);
  return { matrix, offset };
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}

export class WebGLRenderer {
  #canvas;
  #gl;
  #textures = [];
  #width = 0;
  #height = 0;
  // WebGL 1 has no single-channel R8 format; LUMINANCE replicates into .rgb.
  #internalFormat;
  #format;

  constructor(type, canvas, colorSpace) {
    this.#canvas = canvas;
    const gl = (this.#gl = canvas.getContext(type, { antialias: false, depth: false }));
    if (!gl) throw new Error(`${type} is not available`);
    const webgl2 = type === "webgl2";
    this.#internalFormat = webgl2 ? gl.R8 : gl.LUMINANCE;
    this.#format = webgl2 ? gl.RED : gl.LUMINANCE;

    const program = gl.createProgram();
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, vertexShaderSource));
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, fragmentShaderSource));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    gl.useProgram(program);

    // Vertex coordinates, clockwise from bottom-left.
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, +1, +1, +1, +1, -1]), gl.STATIC_DRAW);
    const xy = gl.getAttribLocation(program, "xy");
    gl.vertexAttribPointer(xy, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(xy);

    const { matrix, offset } = conversion(colorSpace);
    gl.uniformMatrix3fv(gl.getUniformLocation(program, "yuvToRgb"), false, matrix);
    gl.uniform3fv(gl.getUniformLocation(program, "yuvOffset"), offset);

    // Plane rows are tightly packed, not 4-byte aligned.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    ["planeY", "planeU", "planeV"].forEach((name, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // LINEAR upsamples chroma; luma is sampled 1:1.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.uniform1i(gl.getUniformLocation(program, name), i);
      this.#textures.push(texture);
    });
  }

  /** `image`: a DecodedImage (8-bit, 3 planes) from JxsCodec.decode. */
  draw(image) {
    const gl = this.#gl;
    const resize = image.width !== this.#width || image.height !== this.#height;
    if (resize) {
      this.#canvas.width = this.#width = image.width;
      this.#canvas.height = this.#height = image.height;
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    }
    for (let i = 0; i < 3; i++) {
      const { width, height } = image.components[i];
      gl.activeTexture(gl.TEXTURE0 + i);
      if (resize) {
        gl.texImage2D(gl.TEXTURE_2D, 0, this.#internalFormat, width, height, 0, this.#format, gl.UNSIGNED_BYTE, image.planes[i]);
      } else {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, width, height, this.#format, gl.UNSIGNED_BYTE, image.planes[i]);
      }
    }
    gl.drawArrays(gl.TRIANGLE_FAN, 0, 4);
  }
}
