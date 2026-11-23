# AlphaMatte Lab

Fast, dependency-light alpha matting engine and interactive web laboratory for high-precision background removal from images, animated GIFs, and videos.

## Features

- **High-Performance CPU Engine**: Multi-stage matting pipeline executing in pure JavaScript / Node.js without requiring PyTorch, CUDA, or heavy neural weights.
- **Microsecond Per-Frame Processing**: Processes 320x320 video frames at ~11 ms/frame and 4K sticker cells in ~580 ms on standard multi-core CPUs.
- **Client-Side Web Studio**: Interactive browser UI powered by React and Web Workers for zero-server client-side matting and instant preview.
- **Video & Animated GIF Matting**: Built-in temporal alpha smoothing pipeline converting input GIF and MP4 files directly into transparent VP9 WebM (`yuva420p`).
- **Topological Edge Protection**: Preserves fine animal fur whiskers, transparent soap bubbles, hot beverage steam, translucent balloons, and high-frequency hair strands without punch-through holes in solid subjects.

## Pipeline Architecture

1. **Analytical Calibration**: Quadrant-based background plane modeling with universal backdrop color detection.
2. **Gradient Analysis**: Separable Sobel filters combined with dual-scale local texture variance estimation.
3. **Boundary Flooding**: Two-pass Manhattan distance transform and inward geodesic depth mapping.
4. **Topological Guard**: Geodesic barrier contours preventing foreground erosion across high-gradient silhouette edges.
5. **Dual-Polarity Unmixing**: Independent sampling for bright highlights and dark strand details.
6. **Guided Refinement**: Fast sub-sampled guided filter for smooth continuous alpha transitions.
7. **Temporal Stabilization**: Inter-frame alpha smoothing for video clips preventing edge jitter.

## Project Structure

```
├── sheet-processor/     # Core matting algorithms and Node.js worker pool
│   ├── v53-matting.mjs  # Primary matting engine implementation
│   ├── video-matting.mjs# Video / GIF to transparent WebM pipeline
│   ├── index.mjs        # Parallel sheet processor with O(1) cell LUT
│   └── cli.mjs          # Command-line interface for batch processing
├── src/                 # React and Vite web laboratory
│   ├── components/      # Viewport, sidebar controls, and telemetry panels
│   └── workers/         # Dedicated Web Worker for client-side processing
├── scripts/             # Benchmarks and command-line automation
└── public/bench/        # SOTA validation datasets and reference metrics
```

## Quick Start

### Installation

```bash
npm install
```

### Running the Web Studio

```bash
npm run dev
```

Open `http://localhost:3000` to launch the interactive viewer.

### Command-Line Video Matting

```bash
node scripts/video-matting-cli.mjs --input sample.mp4 --output sample.webm --fps 15
```

### Running Test Suite

```bash
npm test
```
