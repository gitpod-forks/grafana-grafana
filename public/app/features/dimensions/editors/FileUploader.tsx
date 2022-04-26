import React, { Dispatch, SetStateAction } from 'react';
import { FileDropzone, useTheme2, Button, DropzoneFile } from '@grafana/ui';
import { getBackendSrv, config } from '@grafana/runtime';
import { GrafanaTheme2 } from '@grafana/data';
import { css } from '@emotion/css';
import { MediaType } from '../types';
interface Props {
  setNewValue: Dispatch<SetStateAction<string>>;
  setFormData: Dispatch<SetStateAction<FormData>>;
  mediaType: MediaType;
  setUpload: Dispatch<SetStateAction<boolean>>;
  getRequest: (formData: FormData) => Promise<UploadResponse>;
}
interface UploadResponse {
  err: boolean;
  path: string;
}
export function FileDropzoneCustomChildren({ secondaryText = 'Drag and drop here or browse' }) {
  const theme = useTheme2();
  const styles = getStyles(theme);

  return (
    <div className={styles.iconWrapper}>
      <small className={styles.small}>{secondaryText}</small>
      <Button icon="upload">Upload</Button>
    </div>
  );
}
export const FileUploader = ({ mediaType, setNewValue, setFormData, setUpload, getRequest }: Props) => {
  const onFileRemove = (file: DropzoneFile) => {
    fetch(`/api/storage/delete/upload/${file.file.name}`, {
      method: 'DELETE',
    }).catch((error) => console.error('cannot delete file', error));
  };
  const acceptableFiles =
    mediaType === 'icon' ? 'image/svg+xml' : 'image/jpeg,image/png,image/gif,image/png, image/webp';
  return (
    <FileDropzone
      readAs="readAsBinaryString"
      onFileRemove={onFileRemove}
      options={{
        accept: acceptableFiles,
        multiple: false,
        onDrop: (acceptedFiles: File[]) => {
          let formData = new FormData();
          formData.append('file', acceptedFiles[0]);
          getRequest(formData).then((data) => {
            if (!data.err) {
              getBackendSrv()
                .get(`api/storage/read/${data.path}`)
                .then(() => {
                  setNewValue(`${config.appUrl}api/storage/read/${data.path}`);
                });
            }
          });
          setFormData(formData);
          setUpload(true);
        },
      }}
    >
      <FileDropzoneCustomChildren />
    </FileDropzone>
  );
};

function getStyles(theme: GrafanaTheme2, isDragActive?: boolean) {
  return {
    container: css`
      display: flex;
      flex-direction: column;
      width: 100%;
    `,
    dropzone: css`
      display: flex;
      flex: 1;
      flex-direction: column;
      align-items: center;
      padding: ${theme.spacing(6)};
      border-radius: 2px;
      border: 2px dashed ${theme.colors.border.medium};
      background-color: ${isDragActive ? theme.colors.background.secondary : theme.colors.background.primary};
      cursor: pointer;
    `,
    iconWrapper: css`
      display: flex;
      flex-direction: column;
      align-items: center;
    `,
    acceptMargin: css`
      margin: ${theme.spacing(2, 0, 1)};
    `,
    small: css`
      color: ${theme.colors.text.secondary};
      margin-bottom: ${theme.spacing(2)};
    `,
  };
}