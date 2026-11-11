// Camera-only macOS USB worker. No command input or robot SDK.
#include <librealsense2/rs.hpp>
#include <arpa/inet.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#include <csignal>
#include <cstring>
#include <iostream>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>
#include <cmath>
#include <algorithm>

static void send_all(int socket,const void* bytes,size_t size){
    auto data=static_cast<const char*>(bytes);
    while(size){auto n=::send(socket,data,size,0);if(n<=0)throw std::runtime_error("camera consumer disconnected");data+=n;size-=n;}
}
static void header(int socket,const std::string& value){uint32_t size=htonl(value.size());send_all(socket,&size,4);send_all(socket,value.data(),value.size());}
static std::string quote(const std::string& value){
    std::string result="\"";
    for(unsigned char c:value){if(c=='"'||c=='\\'){result+='\\';result+=c;}else if(c=='\n')result+="\\n";else if(c=='\r')result+="\\r";else if(c>=32)result+=c;}
    return result+'"';
}
static void pixels(int socket,rs2::video_frame frame,int bytes_per_pixel,int width,int height){
    if(frame.get_width()!=width||frame.get_height()!=height||frame.get_stride_in_bytes()<width*bytes_per_pixel)
        throw std::runtime_error("unexpected sensor image dimensions");
    auto data=static_cast<const char*>(frame.get_data());
    for(int y=0;y<height;y++)send_all(socket,data+y*frame.get_stride_in_bytes(),width*bytes_per_pixel);
}
static void capture(int socket){
    rs2::log_to_callback(RS2_LOG_SEVERITY_WARN,[](rs2_log_severity,const rs2::log_message& message){std::cerr<<message.raw()<<std::endl;});
    rs2::context context;
    auto devices=context.query_devices();
    if(devices.size()!=1)throw std::runtime_error("Select exactly one connected RealSense camera");
    std::string serial=devices[0].get_info(RS2_CAMERA_INFO_SERIAL_NUMBER);
    rs2::pipeline pipeline(context);rs2::pipeline_profile profile;
    bool depth=false,infrared=false,started=false;
    std::string last_error;
    for(int mode=0;mode<3;mode++){
        depth=mode!=2;infrared=mode!=1;
        rs2::config config;config.enable_device(serial);
        config.enable_stream(RS2_STREAM_COLOR,640,480,RS2_FORMAT_BGR8,15);
        if(depth)config.enable_stream(RS2_STREAM_DEPTH,640,480,RS2_FORMAT_Z16,15);
        if(infrared)config.enable_stream(RS2_STREAM_INFRARED,1,640,480,RS2_FORMAT_Y8,15);
        try{profile=pipeline.start(config);started=true;break;}
        catch(const rs2::error& error){last_error=error.what();}
    }
    if(!started)throw std::runtime_error(last_error);
    rs2::pointcloud pointcloud;
    auto intr=profile.get_stream(RS2_STREAM_COLOR).as<rs2::video_stream_profile>().get_intrinsics();
    float scale=depth?profile.get_device().first<rs2::depth_sensor>().get_depth_scale():0;
    std::cerr<<"RealSense "<<profile.get_device().get_info(RS2_CAMERA_INFO_NAME)<<" USB "
             <<profile.get_device().get_info(RS2_CAMERA_INFO_USB_TYPE_DESCRIPTOR)<<" depth="<<depth<<" infrared="<<infrared<<std::endl;
    while(true){
        auto frames=pipeline.wait_for_frames(5000);
        auto color=frames.get_color_frame();
        auto distances=frames.get_depth_frame();
        auto ir=infrared?frames.get_infrared_frame(1):rs2::video_frame{rs2::frame{}};
        if(!color||(depth&&!distances)||(infrared&&!ir))continue;
        int width=color.get_width(),height=color.get_height();
        // Aligned Z16 retains depth-camera Z. Calibration needs color optical Z.
        std::vector<float> color_z(width*height,0);
        if(depth){
            pointcloud.map_to(color);auto points=pointcloud.calculate(distances);
            auto vertices=points.get_vertices();auto texture=points.get_texture_coordinates();
            auto extr=distances.get_profile().get_extrinsics_to(color.get_profile());
            for(size_t i=0;i<points.size();i++){
                if(vertices[i].z<=0)continue;
                float z=extr.rotation[2]*vertices[i].x+extr.rotation[5]*vertices[i].y+extr.rotation[8]*vertices[i].z+extr.translation[2];
                int x=std::lround(texture[i].u*width),y=std::lround(texture[i].v*height);
                if(z<=0||x<0||y<0||x>=width||y>=height)continue;
                auto& value=color_z[y*width+x];if(value==0||z<value)value=z;
            }
        }
        std::ostringstream out;
        out<<"{\"version\":1,\"shape\":["<<height<<','<<width<<",3],\"depth\":"<<(depth?"true":"false")
           <<",\"infrared\":"<<(infrared?"true":"false")<<",\"depth_storage\":\"f32\",\"depth_scale\":"<<scale<<",\"intrinsics\":";
        if(depth)out<<'['<<intr.fx<<','<<intr.fy<<','<<intr.ppx<<','<<intr.ppy<<']';else out<<"null";
        out<<",\"calibration\":{\"model\":"<<quote(rs2_distortion_to_string(intr.model))<<",\"coeffs\":[";
        for(int i=0;i<5;i++){if(i)out<<',';out<<intr.coeffs[i];}
        out<<"],\"depth_coordinates\":\"color_z\",\"serial\":"<<quote(serial)<<"}}";
        header(socket,out.str());pixels(socket,color,3,width,height);
        if(depth)send_all(socket,color_z.data(),color_z.size()*sizeof(float));
        if(infrared)pixels(socket,ir,1,width,height);
    }
}
int main(int argc,char** argv){
    if(argc==2&&std::string(argv[1])=="--help"){std::cout<<"Camera-only helper --socket PRIVATE_UNIX_SOCKET\n";return 0;}
    if(argc!=3||std::string(argv[1])!="--socket")return 2;
    std::signal(SIGPIPE,SIG_IGN);
    int socket=::socket(AF_UNIX,SOCK_STREAM,0);if(socket<0)return 3;
    sockaddr_un address{};address.sun_family=AF_UNIX;
    if(std::strlen(argv[2])>=sizeof(address.sun_path)){::close(socket);return 2;}
    std::strcpy(address.sun_path,argv[2]);
    timeval timeout{3,0};setsockopt(socket,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
    if(::connect(socket,reinterpret_cast<sockaddr*>(&address),sizeof(address))){::close(socket);return 3;}
    int result=0;
    try{capture(socket);}
    catch(const std::exception& error){
        std::cerr<<error.what()<<std::endl;result=1;
        try{header(socket,"{\"error\":"+quote(error.what())+'}');}catch(...){}
    }
    ::close(socket);return result;
}
