const vertexShader = /* glsl*/ `
    attribute vec2 vertex_position;
    void main(void) {
        gl_Position = vec4(vertex_position, 0.0, 1.0);
    }
`;

const fragmentShader = /* glsl*/ `
    uniform sampler2D srcTexture;
    uniform vec2 uResolution;
    uniform vec2 uSrcSize;
    void main(void) {
        vec2 uv = gl_FragCoord.xy / uResolution;
        gl_FragColor = texture2D(srcTexture, uv);
    }
`;

export { vertexShader, fragmentShader };
