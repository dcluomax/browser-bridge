use serde_json::Value;
use std::io;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_INCOMING_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_OUTGOING_BYTES: usize = 1024 * 1024;

pub async fn read_message<R: AsyncRead + Unpin>(input: &mut R) -> io::Result<Option<Value>> {
    let mut header = [0u8; 4];
    match input.read_exact(&mut header).await {
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let length = u32::from_le_bytes(header) as usize;
    if length > MAX_INCOMING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("Native message length {length} is out of range."),
        ));
    }
    let mut buffer = vec![0u8; length];
    input.read_exact(&mut buffer).await?;
    let value: Value = serde_json::from_slice(&buffer)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
    Ok(Some(value))
}

pub async fn write_message<W: AsyncWrite + Unpin>(output: &mut W, message: &Value) -> io::Result<()> {
    let payload = serde_json::to_vec(message)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidInput, err))?;
    if payload.len() > MAX_OUTGOING_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Message of {} bytes exceeds the 1 MB native messaging limit.", payload.len()),
        ));
    }
    let header = (payload.len() as u32).to_le_bytes();
    output.write_all(&header).await?;
    output.write_all(&payload).await?;
    output.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn roundtrips_framed_json() {
        let mut buf = Vec::new();
        let msg = json!({ "type": "hello", "text": "héllo 你好" });
        write_message(&mut buf, &msg).await.unwrap();
        let declared = u32::from_le_bytes(buf[..4].try_into().unwrap()) as usize;
        assert_eq!(declared, buf.len() - 4);
        let mut cursor = std::io::Cursor::new(buf);
        assert_eq!(read_message(&mut cursor).await.unwrap(), Some(msg));
        assert_eq!(read_message(&mut cursor).await.unwrap(), None);
    }

    #[tokio::test]
    async fn refuses_oversize_outgoing_messages() {
        let mut buf = Vec::new();
        let huge = json!({ "data": "x".repeat(MAX_OUTGOING_BYTES) });
        assert!(write_message(&mut buf, &huge).await.is_err());
    }
}
