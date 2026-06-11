use pco::standalone::{simple_compress, simple_decompress};
use std::slice;

#[no_mangle]
pub extern "C" fn alloc(len: usize) -> *mut u8 {
    let mut buf = Vec::<u8>::with_capacity(len);
    let ptr = buf.as_mut_ptr();
    std::mem::forget(buf);
    ptr
}

#[no_mangle]
pub extern "C" fn free_u8_input(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    unsafe {
        let _ = Vec::from_raw_parts(ptr, 0, len);
    }
}

macro_rules! export_codec {
    ($compress:ident, $decompress:ident, $free:ident, $ty:ty) => {
        #[no_mangle]
        pub extern "C" fn $compress(
            input_ptr: *const $ty,
            input_len: usize,
            out_len_ptr: *mut u32,
        ) -> *mut u8 {
            let input = unsafe { slice::from_raw_parts(input_ptr, input_len) };
            let out = simple_compress(input, &Default::default())
                .expect(concat!("pcodec wasm compress failed for ", stringify!($ty)));
            let mut out = out.into_boxed_slice();
            let len = out.len() as u32;
            let ptr = out.as_mut_ptr();
            std::mem::forget(out);
            unsafe {
                *out_len_ptr = len;
            }
            ptr
        }

        #[no_mangle]
        pub extern "C" fn $decompress(
            input_ptr: *const u8,
            input_len: usize,
            out_len_ptr: *mut u32,
        ) -> *mut $ty {
            let input = unsafe { slice::from_raw_parts(input_ptr, input_len) };
            let out = simple_decompress::<$ty>(input)
                .expect(concat!("pcodec wasm decompress failed for ", stringify!($ty)));
            let mut out = out.into_boxed_slice();
            let len = out.len() as u32;
            let ptr = out.as_mut_ptr();
            std::mem::forget(out);
            unsafe {
                *out_len_ptr = len;
            }
            ptr
        }

        #[no_mangle]
        pub extern "C" fn $free(ptr: *mut $ty, len: usize) {
            if ptr.is_null() {
                return;
            }
            unsafe {
                let _ = Vec::from_raw_parts(ptr, 0, len);
            }
        }
    };
}

export_codec!(compress_f32, decompress_f32, free_f32, f32);
export_codec!(compress_f64, decompress_f64, free_f64, f64);
export_codec!(compress_i8, decompress_i8, free_i8, i8);
export_codec!(compress_u8, decompress_u8, free_u8, u8);
export_codec!(compress_i16, decompress_i16, free_i16, i16);
export_codec!(compress_u16, decompress_u16, free_u16, u16);
export_codec!(compress_i32, decompress_i32, free_i32, i32);
export_codec!(compress_u32, decompress_u32, free_u32, u32);
export_codec!(compress_i64, decompress_i64, free_i64, i64);
export_codec!(compress_u64, decompress_u64, free_u64, u64);
