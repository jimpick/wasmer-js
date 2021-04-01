// The class for WASI Commands
import { WASI } from '@wasmer/wasi'
import { WasmFs } from '@wasmer/wasmfs'

import './wasm_exec.js'

import Command from './command'
import CommandOptions from './command-options'

export default class WASICommand extends Command {
  constructor (options: CommandOptions) {
    super(options)

    if (!options.module) {
      throw new Error('Did not find a WebAssembly.Module for the WASI Command')
    }
  }

  async run (wasmFs: WasmFs) {
    const options = {
      preopens: {
        '.': '.',
        '/': '/',
        ...(this.options.preopens || {})
      },
      env: this.options.env,
      args: this.options.args,
      bindings: {
        ...WASI.defaultBindings,
        fs: wasmFs.fs
      }
    }
    let wasi = new WASI(options)

    let wasiProxy = new WASI(options)
    wasiProxy.memory = new WebAssembly.Memory({ initial: 1 })
    console.log('Jim wasiProxy', wasiProxy)

    let wasmModule = this.options.module as WebAssembly.Module
    let imports
    let importsProxy: any
    let go
    try {
      imports = wasi.getImports(wasmModule)
      importsProxy = wasiProxy.getImports(wasmModule)
    } catch (e) {
      console.warn('Error detecting WASI, try go', e)
      let response = await fetch('/demo.wasm')
      let wasmModuleProxy = await WebAssembly.compile(
        await response.arrayBuffer()
      )
      const getImports = wasi.getImports.bind(wasiProxy)
      importsProxy = getImports(wasmModuleProxy)
      go = new (window as any).Go({
        wasiProxy: wasiProxy,
        wasiProxyImports:
          importsProxy.wasi_snapshot_preview1 || importsProxy.wasi_unstable
      })
      imports = go.importObject
    }

    if (!imports.go) {
      const getiovs = (iovs: number, iovsLen: number) => {
        wasi.refreshMemory()
        const buffers = Array.from({ length: iovsLen }, (_, i) => {
          const ptr = iovs + i * 8
          const buf = wasi.view.getUint32(ptr, true)
          const bufLen = wasi.view.getUint32(ptr + 4, true)
          return new Uint8Array(wasi.memory.buffer, buf, bufLen)
        })
        return buffers
      }

      const wasiImports = imports.wasi_snapshot_preview1 || imports.wasi_unstable
      const wasiProxyImports =
        importsProxy.wasi_snapshot_preview1 || importsProxy.wasi_unstable
      const old_fd_write = wasiImports.fd_write
      wasiImports.fd_write = function (
        fd: number,
        iovs: number,
        iovsLen: number,
        nwritten: number
      ) {
        console.log('Jim fd_write', fd, iovs, iovsLen, nwritten)
        wasiProxy.refreshMemory()
        const proxyIovs = iovs // 0
        const newIovs = 0
        let newBufPtr = 8 * iovsLen
        getiovs(iovs, iovsLen).forEach((iov, i) => {
          const utf8decoder = new TextDecoder()
          console.log('Jim iov', utf8decoder.decode(new Uint8Array(iov)))
          // Copy iov to proxy memory
          const ptr = iovs + i * 8
          const buf = wasi.view.getUint32(ptr, true)
          const bufLen = wasi.view.getUint32(ptr + 4, true)
          const newPtr = newIovs + i * 8
          wasiProxy.view.setUint32(newPtr, newBufPtr, true)
          wasiProxy.view.setUint32(newPtr + 4, bufLen, true)
          // FIXME: Copy bytes in
          const dest = new Uint8Array(wasiProxy.memory.buffer, newBufPtr, bufLen)
          newBufPtr += bufLen
          dest.set(iov)
        })
        const newNwritten = newBufPtr
        old_fd_write(fd, iovs, iovsLen, nwritten)
        wasiProxyImports.fd_write(fd, newIovs, iovsLen, newNwritten)
      }
    }

    console.log('Jim imports', imports)
    let instance = await WebAssembly.instantiate(wasmModule, imports)
    if (go) {
      go.run(instance)
    } else {
      wasi.start(instance)
    }
  }
}
