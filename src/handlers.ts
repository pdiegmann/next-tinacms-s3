/**
Copyright 2021 Forestry.io Holdings, Inc.
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at
    http://www.apache.org/licenses/LICENSE-2.0
Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/
import * as fs from 'fs';
import { Upload } from "@aws-sdk/lib-storage";
import { URL } from 'node:url';
import { DeleteObjectCommand, ListObjectsCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Media, MediaListOptions } from '@tinacms/toolkit'
import path from 'path'
import { NextApiRequest, NextApiResponse } from 'next'
import multer from 'multer'
import { promisify } from 'util'

export interface S3Config {
  endpoint: string
  cdn_base_url: string,
  bucket: string
  access_key: string
  access_secret: string
  region: string
  authorized: (req: NextApiRequest, res: NextApiResponse) => Promise<boolean>
}

export const mediaHandlerConfig = {
  api: {
    bodyParser: false,
  },
}

let client : S3Client;

export const createMediaHandler = (
  config: S3Config
) => {
  client = new S3Client({
    bucketEndpoint: false, 
    endpoint: config.endpoint,
    region: config.region,
    credentials: {
      accessKeyId: config.access_key,
      secretAccessKey: config.access_secret
    }
  })

  return async (req: NextApiRequest, res: NextApiResponse) => {
    const isAuthorized = await config.authorized(req, res)
    // make sure the user is authorized to upload
    if (!isAuthorized) {
      res.status(401).json({ message: 'sorry this user is not authorized' })
      return
    }
    switch (req.method) {
      case 'GET':
        return listMedia(req, res, config)
      case 'POST':
        return uploadMedia(req, res, config)
      case 'DELETE':
        return deleteAsset(req, res, config)
      default:
        res.end(404)
    }
  }
}

async function uploadMedia(req: NextApiRequest, res: NextApiResponse, config?: S3Config) {
  const upload = promisify(
    multer({
      storage: multer.diskStorage({
        //@ts-ignore
        directory: (req, file, cb) => {
          cb(null, '/tmp')
        },
        filename: (req, file, cb) => {
          cb(null, file.originalname)
        },
      }),
    }).single('file')
  )

  //@ts-ignore
  await upload(req, res)

  const { directory } = req.body

  try {
    const parallelUploads3 = new Upload({
      client: client,
      params: { 
        Bucket: config.bucket,
        ACL: 'public-read', 
        //@ts-ignore
        Key: directory.replace(/^\//, '') + req.file.originalname,
        //@ts-ignore
        Body: fs.createReadStream(req.file.path)
      },
      //queueSize: 4, // optional concurrency configuration
      //partSize: 1024 * 1024 * 64, // optional size of each part, in bytes, at least 5MB
      leavePartsOnError: false, // optional manually handle dropped parts
    });

    parallelUploads3.on("httpUploadProgress", (progress) => {
      console.log(progress);
    });

    const upload_result = await parallelUploads3.done();
    res.json(upload_result)
    
  } catch (e) {
    console.log(e)
    res.send(500)
  }
}

async function listMedia(
  req: NextApiRequest,
  res: NextApiResponse,
  config: S3Config
) {
  try {
    const {
      directory = undefined,
      limit = 500,
      offset,
    } = req.query as MediaListOptions

    const useRootDirectory =
      !directory || directory === '/' || directory === '""'

    const command = new ListObjectsCommand({
      Bucket: config.bucket,
      Prefix: useRootDirectory ? "" : directory,
      MaxKeys: limit,
      Marker: offset as string,
    })

    const response = await client.send(command);
    const files = response.Contents ? response.Contents.map(getS3ToTinaFunc(config)) : []

    // folders?
    // type: 'dir'
    const folders = []

    res.json({
      items: [...folders, ...files],
      offset: response.NextMarker,
    })
  } catch (e) {
    res.status(500)
    const message = findErrorMessage(e)
    res.json({ e: message })
  }
}

/**
 * we're getting inconsistent errors in this try-catch
 * sometimes we just get a string, sometimes we get the whole response.
 * I suspect this is coming from S3 SDK so let's just try to
 * normalize it into a string here.
 */
const findErrorMessage = (e: any) => {
  if (typeof e == 'string') return e
  if (e.message) return e.message
  if (e.error && e.error.message) return e.error.message
  return 'an error occurred'
}

async function deleteAsset(req: NextApiRequest, res: NextApiResponse, config: S3Config) {
  const { media } = req.query
  const [, public_id] = media as string[]

  const command = new DeleteObjectCommand({Bucket:config.bucket, Key:public_id as string})

  client.send(command)
  .then((data) => {
    res.json({
      undefined,
      public_id,
    })
  })
  .catch((error) => {
    // error handling.
    res.status(500)
  })
}
function getS3ToTinaFunc(config: S3Config) {
  return function S3ToTina(file: any): Media {
    const bucketUrl = "https://" + config.cdn_base_url + "/";
    const filename = file.Key
    const url = new URL(bucketUrl + filename)

    const directory = url.pathname.substring(0, url.pathname.lastIndexOf('/'))

    return {
      id: file.Key,
      filename: filename,
      directory,
      src: url.href,
      previewSrc: filename.endsWith('.mp4') ? 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAASsAAACoCAMAAACPKThEAAAARVBMVEWqqqrMzMz///+5ubmnp6ekpKTn5+f39/erq6vt7e3JycnY2NixsbHp6en7+/vBwcHh4eHS0tK1tbXx8fHc3Ny9vb3ExMRKCGhtAAAEdklEQVR4nO3d63KbMBSFUTgIJEDcL+//qEV13TppBDvGntMO+5vpn9ZuyRpBZIHSpK5ShpVkJjEMKskShkYrPFrh0QqPVni0wqMVHq3waIVHKzxa4dEKj1Z4tMKjFR6t8GiFRys8WuHRCo9WeLTCoxUerfBohUcrPFrh0QqPVni0wqMVHq3waIVHKzxa4dEKj1Z4tMKjFR6t8GiFRys8WuHRCo9WeLTCoxUerfBohUcrPFrh0QqPVni0wqMVHq3waIWnbOW2X7efqpGb/LHb75j89w/duL9aMUWrm8G4rNVQz3PfF01R3muKouj7fp7rehjSdV2y0f/k0ztcNSuXGLf2pZWP2XutfNXUp6OilpKVSYZAU/b1UHVh0Gx4+ae2Qee892OWdd1apcNcBMJyUdPSsTKjlbLyJr9dj5K9L//PDwrKc7/MIrUWloqVyVqp7hfs770z940aloqVs/L8mWQK6XSwNKxMvY2qZ9/sEt9O17HybXnmi83rE6PyTApWZjkxrML7R6UrloZVKuf+VWeby1jNMp77C0r7okP5XhpWhT33wW7D9i86lm+lYTVFv4856Nwyw8mB+WQKVs4WeeSPzOABLVNJ99IjAlOw8jLHQEwjw/F0fvtGmmpc3FWshqhVITJ1R1om05k0KFiN8VERrET6oxNxlP4aVtuoiE5Fb1bSpvtDy7fFRawWWQ+sthMxi13+Q65VmYwqWHXxdYLfViLzzqLWNnF/z7Htp2C1QlbSVnnsZoSxKisNClZVfJng0UqkjC2u0yr5bCVSfz2wjD21qPNs/7aVFF+/7DJWKW41RF5Gq89WzRiZZhmdBSwFqwGzatfoFOs646rC5lc7U3daJQ9W5bg/b4+u6rwzhc/O6+FnnDAN3Xsoxl3m82B3uM7gDkaNb/trjCuT7axfNdvH5uXQYWe18J2prPVFV+rCuujugyC3lG4QqlhFV+qw9fYku8wasrNlfOaEPOe4XfHWVx4QmsbzDPF7XljhxvVFxpVpzt5LrQU6VV+dzj36c7eN87M3rp9Mw6qS5dxfME0vOpTvpXG92iZYp6aSStN2FSt3bgl4b+L/1pSegTzzYJ6ZWpXHZHSsfGuxJ2K+fHevNKyUntleZRqf2y9iXLFN+3U25ujsBcgrkTozeZ6E/zL56NW3DU5hU0DuB6vzuTmktcckK0VsU6fr8nOHiftrh8mH3SbOZ8uaDn14U3Tx6+1p7fMyJqvLjzuUWjtNv7Z43WvKcrIPG5xsvwLLEO9Kb09cOKWSsavSoQ5b4opic5ls+2GLV2uDX1PMYYtT5sK2FMU9hNr7Uh82Ju2dhOap3TsvTtvqf4pWeLTCoxUerfBohUcrPFrh0QqPVni0wqMVHq3waIVHKzxa4dEKj1Z4tMKjFR6t8GiFRys8WuHRCo9WeLTCoxUerfBohUcrPFrh0QqPVni0wqMVHq3waIVHKzxa4dEKj1Z4tMKjFR6t8GiFRys8WuHRCo9WeLTCoxUerfBohUcrPFrh0QqPVni0gvsBO1Qk0wQ2QcwAAAAASUVORK5CYII=' : transformS3Image(
        url.href,
        'w_125,h_125,c_fill,q_auto'
      ),
      type: 'file',
    }
  }
}

function transformS3Image(
  url: string,
  transformations: string
): string {
  const parts = url.split('/image/upload/')

  if (parts.length === 2) {
    return parts[0] + '/image/upload/' + transformations + '/' + parts[1]
  }

  return url
}
