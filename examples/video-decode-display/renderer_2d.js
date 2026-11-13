// Same path as the WebCodecs sample's Canvas2DRenderer: wrap the decoded
// planes in a VideoFrame and let the browser convert and draw it.
export class Canvas2DRenderer {
  #canvas;
  #ctx;
  #colorSpace;

  constructor(canvas, colorSpace) {
    this.#canvas = canvas;
    this.#ctx = canvas.getContext("2d");
    this.#colorSpace = colorSpace;
  }

  /** `image`: a DecodedImage (8-bit yuv420) from JxsCodec.decode. */
  draw(image) {
    const { width, height, data } = image;
    if (this.#canvas.width !== width || this.#canvas.height !== height) {
      this.#canvas.width = width;
      this.#canvas.height = height;
    }
    // The decoded planes are tightly packed in I420 order, so `data` can be
    // handed over as is (and transferred, it is not used afterwards).
    const frame = new VideoFrame(data, {
      format: "I420",
      codedWidth: width,
      codedHeight: height,
      timestamp: 0,
      colorSpace: this.#colorSpace,
      transfer: [data.buffer],
    });
    this.#ctx.drawImage(frame, 0, 0, width, height);
    frame.close();
  }
}
