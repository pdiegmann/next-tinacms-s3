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

import { DeleteObjectCommand, ListObjectsCommand, S3Client } from "@aws-sdk/client-s3";
import { Media, MediaListOptions } from '@tinacms/toolkit'
import path from 'path'
import { NextApiRequest, NextApiResponse } from 'next'
import multer from 'multer'
import { promisify } from 'util'

export interface S3Config {
  endpoint: string
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

var client;

export const createMediaHandler = (
  config: S3Config
) => {
  client = new S3Client(config)

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

  //@ts-ignore
  const command = new PutObjectCommand({
    Bucket: "",
    //@ts-ignore
    Key: directory.replace(/^\//, '') + '/' + req.file.path,
    //@ts-ignore
    Body: req.file 
  })
  const result = await client.send(command)

  res.json(result)
}

async function listMedia(
  req: NextApiRequest,
  res: NextApiResponse,
  config: S3Config
) {
  try {
    const {
      directory = '""',
      limit = 500,
      offset,
    } = req.query as MediaListOptions

    const useRootDirectory =
      !directory || directory === '/' || directory === '""'

    const command = new ListObjectsCommand({
      Bucket: "",
      Prefix: useRootDirectory ? "" : directory,
      MaxKeys: limit,
      Marker: offset as string
    })

    const response = await client.send(command);

    const files = response.Contents.map(getS3ToTinaFunc(config))
    // folders?
    // type: 'dir'
    const folders = []

    res.json({
      items: [...folders, ...files],
      offset: response.next_cursor,
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
    const bucketUrl = config.endpoint + "/" + config.bucket + "/";
    const url = bucketUrl + encodeURIComponent(file.Key)

    const filename = path.basename(file.public_id)
    const directory = path.dirname(file.public_id)

    return {
      id: file.Key,
      filename,
      directory,
      src: url,
      previewSrc: transformS3Image(
        url,
        'w_75,h_75,c_fill,q_auto'
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