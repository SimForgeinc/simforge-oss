//! Reduce reverse-Z on the GPU before readback. Only packed metric f16 + mask
//! cross PCIe; RGB keeps its original resolution and shading.
use bevy::render::renderer::RenderDevice;

pub(super) struct Reducer(wgpu::ComputePipeline);

impl Reducer {
    pub(super) fn new(device: &RenderDevice, scale: u32) -> Self {
        let gpu = device.wgpu_device();
        let shader = gpu.create_shader_module(wgpu::ShaderModuleDescriptor {
            label: Some("metric depth reduction"),
            source: wgpu::ShaderSource::Wgsl(include_str!("depth_reduce.wgsl").into()),
        });
        Self(gpu.create_compute_pipeline(&wgpu::ComputePipelineDescriptor {
            label: Some("metric depth reduction"), layout: None, module: &shader,
            entry_point: Some("main"),
            compilation_options: wgpu::PipelineCompilationOptions { constants: &[("SCALE", scale as f64)], ..Default::default() },
            cache: None,
        }))
    }

    pub(super) fn encode(&self, device: &RenderDevice, encoder: &mut wgpu::CommandEncoder,
        texture: &wgpu::Texture, output: &wgpu::Buffer, staging: &wgpu::Buffer, scale: u32) {
        let view = texture.create_view(&Default::default());
        let binding = device.wgpu_device().create_bind_group(&wgpu::BindGroupDescriptor {
            label: Some("metric depth reduction"), layout: &self.0.get_bind_group_layout(0),
            entries: &[
                wgpu::BindGroupEntry { binding: 0, resource: wgpu::BindingResource::TextureView(&view) },
                wgpu::BindGroupEntry { binding: 1, resource: output.as_entire_binding() },
            ],
        });
        {
            let mut pass = encoder.begin_compute_pass(&wgpu::ComputePassDescriptor {
                label: Some("metric depth reduction"), timestamp_writes: None,
            });
            pass.set_pipeline(&self.0);
            pass.set_bind_group(0, &binding, &[]);
            pass.dispatch_workgroups((texture.width()/scale).div_ceil(8), (texture.height()/scale).div_ceil(8), 1);
        }
        encoder.copy_buffer_to_buffer(output, 0, staging, 0, output.size());
    }
}
