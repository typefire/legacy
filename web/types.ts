import {Tag} from "@typefire/transform";

export interface IServer {
    get<T extends (...args: any[]) => any>(route: string, handler: T): IServer;

    post<T extends (...args: any[]) => any>(route: string, handler: T): IServer;

    serve(port: number): void;
}

export interface HttpRequest<T> {
    params: Record<string, string>
    query: URLSearchParams | undefined
    body: T
}

export declare function createHttpServer(): IServer;

export type FilterQuery<T> = (model: T) => boolean

export type Body<T> = T


export type Data = Tag

export type FromQuery<T, K extends string = ''> = T & Data & Tag

export type FromPath<T> = FromQuery<T>
